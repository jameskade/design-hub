"""隔离的 Sketch 快照任务；接收可并发，渲染队列单工作进程，发布复用现有版本事务。"""
import base64
import json
import os
from pathlib import Path, PurePosixPath
import queue
import re
import shutil
import signal
import struct
import subprocess
import threading
import time
import uuid
import zipfile

try:
    from .source_packages import SourcePackages, split_design
    from .sketch_parser import PARSER_VERSION, parse_design
except ImportError:
    from source_packages import SourcePackages, split_design
    from sketch_parser import PARSER_VERSION, parse_design

TERMINAL = {"complete", "failed", "cancelled"}
MAX_INPUT = 100 * 1024**2
MAX_EXPANDED = 512 * 1024**2
MAX_WORK = 3 * 1024**3
RESERVE = 2 * 1024**3
ID = re.compile(r"^[A-Za-z0-9-]{1,80}$")


class Cancelled(Exception):
    pass


def read_archive(path):
    # 不 extractall：拒绝目录穿越、链接、重复条目和解压炸弹。
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        names = [i.filename for i in infos]
        if len(infos) > 20000 or len(set(names)) != len(names) or sum(i.file_size for i in infos) > MAX_EXPANDED:
            raise ValueError("快照条目或解压体积超过限制")
        for i in infos:
            p = PurePosixPath(i.filename)
            if p.is_absolute() or ".." in p.parts or "\\" in i.filename or (i.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError("快照包含不安全路径")
        return {i.filename: archive.read(i) for i in infos if not i.is_dir() and not i.filename.startswith("__MACOSX/") and not PurePosixPath(i.filename).name.startswith("._")}


def validate_snapshot(path, boards):
    files = read_archive(path)
    document = json.loads(files["document.json"])
    meta = json.loads(files["meta.json"])
    if "user.json" not in files:
        raise ValueError("快照缺少 user.json")
    def references(value):
        if isinstance(value, dict):
            ref = value.get("_ref")
            if ref:
                if not isinstance(ref, str) or not re.fullmatch(r"(pages|images|fonts)/[A-Za-z0-9._-]+", ref) or ".." in ref:
                    raise ValueError("快照外部引用无效")
                name = ref + ".json" if ref.startswith("pages/") else ref
                if name not in files:
                    raise ValueError("快照缺少图片、字体或页面依赖")
            for child in value.values():
                references(child)
        elif isinstance(value, list):
            for child in value:
                references(child)
    for name, raw in files.items():
        if name.endswith(".json"):
            references(json.loads(raw))
    if meta.get("appVersion") != "2025.3.4":
        raise ValueError("测试版仅接收 Sketch 2025.3.4 快照")
    wanted = {b["sketch_id"] for b in boards}
    seen = set()
    all_ids = set()
    def walk(layer):
        key = layer.get("do_objectID")
        if key:
            if key in all_ids:
                raise ValueError("快照存在重复图层 ID")
            all_ids.add(key)
        for child in layer.get("layers", []):
            walk(child)
    for page_ref in document["pages"]:
        page = json.loads(files[page_ref["_ref"] + ".json"])
        for layer in page.get("layers", []):
            if layer.get("do_objectID") in wanted:
                seen.add(layer["do_objectID"])
            elif layer.get("_class") != "symbolMaster":
                raise ValueError("快照包含未选择的画板")
            walk(layer)
    if seen != wanted:
        raise ValueError("快照缺少所选画板")
    for board in boards:
        for asset in board["resources"]:
            if asset["layer_id"] not in all_ids:
                raise ValueError("资源图层与快照不匹配")
    return files


class SnapshotJobs:
    def __init__(self, app):
        self.app = app
        self.root = app.DATA_DIR / ".snapshot-jobs"
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = threading.RLock()
        self.jobs = {}
        self.space_checks = {}
        self.pending = queue.Queue()
        self.stopping = threading.Event()
        self.validation = threading.Semaphore(1)
        self.tool = os.environ.get("DESIGN_HUB_SKETCHTOOL", "/Applications/Sketch.app/Contents/MacOS/sketchtool")
        self.sources = SourcePackages(app.DATA_DIR / "source-blobs")
        with app.db_connection() as db:
            db.execute("CREATE TABLE IF NOT EXISTS snapshot_commits (id TEXT PRIMARY KEY, results TEXT NOT NULL, created REAL NOT NULL)")
        for path in self.root.glob("*/state.json"):
            if not re.fullmatch(r"[0-9a-f-]{36}", path.parent.name):
                continue
            job = json.loads(path.read_text())
            self.jobs[job["id"]] = job
            pid = job.pop("renderer_pid", None)
            if isinstance(pid, int):
                # 仅回收本任务遗留的独立进程组；PID 重用时不能误杀其他进程。
                command = subprocess.run(["/bin/ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True).stdout
                if self.tool in command and str(path.parent / "work") in command:
                    try:
                        if os.getpgid(pid) == pid:
                            os.killpg(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
            # 重启不盲目重放发布；先安全失败，再允许用户重新提交。
            if job["state"] not in TERMINAL:
                with app.db_connection() as db:
                    committed = db.execute("SELECT results FROM snapshot_commits WHERE id=?", (job["id"],)).fetchone()
                if committed:
                    job.update(state="complete", results=json.loads(committed[0]), updated=time.time())
                else:
                    job.update(state="failed", error="服务重启，请重新提交", updated=time.time())
                self.save(job)
            self.cleanup(job)
        self.thread = threading.Thread(target=self.worker, daemon=True, name="snapshot-render")
        self.thread.start()

    def close(self):
        self.stopping.set()
        with self.lock:
            for job in self.jobs.values():
                if job["state"] not in TERMINAL:
                    job["cancel_requested"] = True
        self.pending.put(None)
        self.thread.join(timeout=5)

    def save(self, job):
        path = self.root / job["id"] / "state.json"
        temporary = path.with_suffix(".tmp")
        # 进度持久化不反复重写整份标注；崩溃恢复只需要状态和发布日志。
        temporary.write_text(json.dumps({k: v for k, v in job.items() if k not in {"boards", "baseline"}}, ensure_ascii=False))
        os.replace(temporary, path)

    def update(self, job, **values):
        with self.lock:
            job.update(values, updated=time.time())
            self.save(job)

    def cleanup(self, job):
        # 仅删除该任务私有工作目录；最终版本已由发布事务保存在 projects 下。
        work = self.root / job["id"] / "work"
        if work.exists():
            shutil.rmtree(work)
        if job["state"] != "complete":
            for name in job.get("publish_paths", []):
                path = Path(name).resolve()
                if self.app.PROJECT_DATA_DIR in path.parents and re.fullmatch(r"[0-9a-f-]{36}", path.name) and path.is_dir():
                    shutil.rmtree(path)
        with self.lock:
            for key in ("boards", "baseline", "publish_paths"):
                job.pop(key, None)
            self.save(job)

    def check(self, job):
        if job.get("cancel_requested"):
            raise Cancelled()
        now = time.monotonic()
        if now - self.space_checks.get(job["id"], 0) < 1:
            return
        self.space_checks[job["id"]] = now
        work = self.root / job["id"] / "work"
        size = sum(p.stat().st_size for p in work.rglob("*") if p.is_file())
        if size > MAX_WORK or shutil.disk_usage(self.root).free < RESERVE:
            raise ValueError("渲染临时空间不足，任务已停止，旧版本不变")

    def authorize(self, job, user):
        if job["user_id"] != user["id"] and user["role"] != "admin":
            raise self.app.ApiError(403, "不能访问其他人的上传任务")
        with self.app.db_connection() as db:
            self.app.require_project_role(db, user, job["project_id"], {"editor", "owner", "admin"})

    def public(self, job):
        return {k: job.get(k) for k in ("id", "state", "phase", "done", "total", "received", "size", "error", "results", "created", "updated")}

    def create(self, user, project_id, data):
        app = self.app
        boards = data.get("boards")
        size = data.get("size")
        if not isinstance(boards, list) or not 1 <= len(boards) <= 100 or type(size) is not int or not 1 <= size <= MAX_INPUT:
            raise app.ApiError(400, "画板数量或快照大小无效（最多100张、100MB）")
        ids = set()
        total = 0
        for board in boards:
            if not isinstance(board, dict) or not ID.fullmatch(str(board.get("sketch_id", ""))) or board["sketch_id"] in ids:
                raise app.ApiError(400, "画板 ID 无效或重复")
            ids.add(board["sketch_id"])
            if not isinstance(board.get("metadata"), dict) or not isinstance(board.get("resources"), list):
                raise app.ApiError(400, "缺少标注或资源清单")
            if not isinstance(board.get("name"), str) or not 1 <= len(board["name"]) <= 160:
                raise app.ApiError(400, "画板名称无效")
            for dimension in (board.get("width"), board.get("height")):
                if not isinstance(dimension, (int, float)) or not 0 < dimension <= 10000:
                    raise app.ApiError(400, "画板尺寸超限")
            resource_ids = set()
            for resource in board["resources"]:
                if not isinstance(resource, dict) or not ID.fullmatch(str(resource.get("layer_id", ""))) or resource["layer_id"] in resource_ids:
                    raise app.ApiError(400, "资源 ID 无效或重复")
                resource_ids.add(resource["layer_id"])
            total += len(resource_ids)
        if total > 10000:
            raise app.ApiError(413, "单任务最多10000个资源图层")
        if not Path(self.tool).is_file():
            raise app.ApiError(503, "服务器未配置 Sketch 渲染工具")
        version = subprocess.run([self.tool, "--version"], capture_output=True, text=True, timeout=15)
        if version.returncode or "2025.3.4" not in version.stdout:
            raise app.ApiError(503, "服务器需要 Sketch 2025.3.4 渲染工具")
        with self.lock, app.WRITE_LOCK, app.db_connection() as db:
            app.require_project_role(db, user, project_id, {"editor", "owner", "admin"})
            folder = db.execute("SELECT id FROM folders WHERE id=? AND project_id=? AND deleted_at IS NULL", (data.get("folder_id"), project_id)).fetchone()
            if not folder:
                raise app.ApiError(404, "目标目录不存在")
            active = [j for j in self.jobs.values() if j["state"] not in TERMINAL]
            if len(active) >= 10 or sum(j["user_id"] == user["id"] for j in active) >= 3:
                raise app.ApiError(429, "等待任务过多，请稍后再试")
            if shutil.disk_usage(self.root).free < RESERVE + MAX_WORK + sum(j["size"] for j in active) + size:
                raise app.ApiError(507, "服务器临时空间不足，未接收任务")
            baseline = {}
            for key in ids:
                row = db.execute("SELECT current_version_id FROM artboards WHERE project_id=? AND sketch_id=?", (project_id, key)).fetchone()
                baseline[key] = row[0] if row else None
            job = dict(id=str(uuid.uuid4()), user_id=user["id"], project_id=project_id, folder_id=folder[0],
                       boards=boards, baseline=baseline, size=size, received=0, state="receiving", phase="等待上传",
                       done=0, total=total + len(boards), created=time.time(), updated=time.time(), results=[])
            (self.root / job["id"] / "work").mkdir(parents=True, mode=0o700)
            self.jobs[job["id"]] = job
            self.save(job)
            return self.public(job)

    def receive(self, handler, job):
        if int(handler.headers.get("Content-Length", "0")) != job["size"]:
            raise self.app.ApiError(400, "快照长度不匹配")
        with self.lock:
            if job["state"] != "receiving" or job.get("transferring"):
                raise self.app.ApiError(409, "任务不再接收文件")
            job["transferring"] = True
        work = self.root / job["id"] / "work"
        previous_timeout = handler.connection.gettimeout()
        handler.connection.settimeout(20)
        try:
            remaining = job["size"]
            with (work / "input.sketch").open("wb") as out:
                while remaining:
                    self.check(job)
                    block = handler.rfile.read(min(256 * 1024, remaining))
                    if not block:
                        raise ValueError("快照上传中断")
                    out.write(block)
                    remaining -= len(block)
                    self.update(job, received=job["size"] - remaining, phase="上传中")
            with self.validation:
                self.check(job)
                validate_snapshot(work / "input.sketch", job["boards"])
            with self.lock:
                if job.get("cancel_requested"):
                    raise Cancelled()
                self.update(job, state="queued", phase="排队中")
                self.pending.put(job["id"])
        except Exception as error:
            was_cancelled = isinstance(error, Cancelled) or job.get("cancel_requested")
            self.update(job, state="cancelled" if was_cancelled else "failed", error="上传已取消" if was_cancelled else "快照上传或校验失败")
            self.cleanup(job)
            raise self.app.ApiError(400, job["error"]) from error
        finally:
            job["transferring"] = False
            handler.connection.settimeout(previous_timeout)
        return self.public(job)

    def cancel(self, job):
        with self.lock:
            if job["state"] == "complete":
                raise self.app.ApiError(409, "任务已经发布，不能取消")
            if job["state"] not in TERMINAL:
                self.update(job, cancel_requested=True, phase="正在取消")
                if job["state"] in {"queued", "receiving"} and not job.get("transferring"):
                    self.update(job, state="cancelled", phase="已取消")
                    self.cleanup(job)
            return self.public(job)

    def command(self, job, args):
        self.check(job)
        # 每次只持有本任务自己的进程组；取消不操作其他 Sketch/用户任务。
        log = (self.root / job["id"] / "work" / "renderer.log").open("wb")
        process = subprocess.Popen([self.tool, *args], stdout=log, stderr=log, start_new_session=True)
        self.update(job, renderer_pid=process.pid)
        start = time.monotonic()
        try:
            while process.poll() is None:
                self.check(job)
                if time.monotonic() - start > 120:
                    raise ValueError("单次渲染超时")
                time.sleep(0.2)
            if process.returncode:
                log.flush()
                print("[Snapshot][Render] 任务", job["id"], "退出码", process.returncode, flush=True)
                raise ValueError("Sketch 渲染失败")
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            log.close()
            with self.lock:
                job.pop("renderer_pid", None)
                self.save(job)

    def render(self, job):
        work = self.root / job["id"] / "work"
        source = work / "input.sketch"
        files = validate_snapshot(source, job["boards"])
        source_packages = {board["sketch_id"]: split_design(files, board["sketch_id"]) for board in job["boards"]}
        sketch_version = str(json.loads(files["meta.json"]).get("appVersion") or "")
        # 只改隔离副本，用同一原生渲染器生成无阴影资源，不修改原设计稿。
        def disable(value):
            if isinstance(value, dict):
                for shadow in value.get("shadows", []):
                    shadow["isEnabled"] = False
                for nested in value.values():
                    disable(nested)
            elif isinstance(value, list):
                for nested in value:
                    disable(nested)
        shadowless = work / "shadowless.sketch"
        with zipfile.ZipFile(shadowless, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, data in files.items():
                if name.endswith(".json"):
                    value = json.loads(data); disable(value); data = json.dumps(value).encode()
                archive.writestr(name, data)
        del files
        rendered = []
        done = 0
        for index, board in enumerate(job["boards"]):
            self.update(job, phase=f"导出画板 {index + 1}/{len(job['boards'])}")
            directory = work / str(index)
            directory.mkdir()
            def export(key, path, fmt, scales, target):
                self.command(job, ["export", "layers", str(path), "--item=" + key, "--output=" + str(target), "--formats=" + fmt, "--scales=" + scales, "--use-id-for-name", "--serial"])
            export(board["sketch_id"], source, "png", "2", directory / "preview")
            preview = list((directory / "preview").glob("*.png"))
            if len(preview) != 1:
                raise ValueError("画板预览缺失")
            payload = {k: board[k] for k in ("sketch_id", "name", "width", "height", "metadata", "canvas_x", "canvas_y") if k in board}
            payload["design_context"] = parse_design(source_packages[board["sketch_id"]], board["sketch_id"])
            payload["parser_version"] = PARSER_VERSION
            payload["preview_base64"] = base64.b64encode(preview[0].read_bytes()).decode()
            assets = []
            done += 1
            # 小批量复用一次快照解析；仍使用 --serial，避免渲染并发耗尽内存。
            for offset in range(0, len(board["resources"]), 24):
                batch = board["resources"][offset:offset + 24]
                keys = ",".join(r["layer_id"] for r in batch)
                self.update(job, phase=f"画板 {index + 1}/{len(job['boards'])} · 资源 {offset + 1}–{offset + len(batch)}")
                for fmt, scales in [("png", "1,2,3"), ("svg", "1")]:
                    self.command(job, ["export", "layers", str(source), "--items=" + keys, "--output=" + str(directory / "slice"), "--formats=" + fmt, "--scales=" + scales, "--use-id-for-name", "--serial"])
                shadow_keys = ",".join(r["layer_id"] for r in batch if r.get("has_shadow"))
                if shadow_keys:
                    self.command(job, ["export", "layers", str(shadowless), "--items=" + shadow_keys, "--output=" + str(directory / "slice-no-shadow"), "--formats=png", "--scales=1,2,3", "--use-id-for-name", "--serial"])
                self.update(job, done=done + offset + len(batch))
            for resource in board["resources"]:
                key = resource["layer_id"]
                for kind, path in [("slice", source)] + ([("slice-no-shadow", shadowless)] if resource.get("has_shadow") else []):
                    target = directory / kind
                    paths = sorted(p for p in target.glob(key + "*") if p.stem == key or re.fullmatch(re.escape(key) + r"@[123]x", p.stem))
                    pngs = [p for p in paths if p.suffix == ".png"]
                    if len(pngs) != 3:
                        raise ValueError("资源倍率不完整")
                    scales = set()
                    for p in paths:
                        if p.suffix not in {".png", ".svg"}:
                            continue
                        match = re.search(r"@(\d+)x\.", p.name)
                        scale = int(match.group(1)) if match else 1
                        if p.suffix == ".png":
                            scales.add(scale)
                            with p.open("rb") as f:
                                header = f.read(24)
                            if header[:8] != b"\x89PNG\r\n\x1a\n":
                                raise ValueError("PNG 资源无效")
                            width, height = struct.unpack(">II", header[16:24])
                        else:
                            width, height = resource.get("width"), resource.get("height")
                        assets.append((dict(layer_id=key, name=resource.get("name", key), kind=kind, format=p.suffix[1:], scale=scale, width=width, height=height), p))
                    if scales != {1, 2, 3}:
                        raise ValueError("资源倍率不匹配")
                done += 1
            self.update(job, done=done)
            rendered.append((payload, assets, source_packages[board["sketch_id"]], sketch_version))
        return rendered

    def publish(self, job, rendered):
        app = self.app
        # 取消和发布共用短临界区；整个任务同一事务，冲突/权限变化时不发布部分画板。
        with self.lock, app.WRITE_LOCK, app.db_connection() as db:
            self.check(job)
            user = db.execute("SELECT * FROM users WHERE id=?", (job["user_id"],)).fetchone()
            if not user or user["role"] not in {"admin", "designer"}:
                raise ValueError("上传用户已失去权限")
            app.require_project_role(db, user, job["project_id"], {"editor", "owner", "admin"})
            if not db.execute("SELECT id FROM folders WHERE id=? AND project_id=? AND deleted_at IS NULL", (job["folder_id"], job["project_id"])).fetchone():
                raise ValueError("目标目录已不存在")
            for key, version in job["baseline"].items():
                row = db.execute("SELECT current_version_id FROM artboards WHERE project_id=? AND sketch_id=?", (job["project_id"], key)).fetchone()
                if (row[0] if row else None) != version:
                    raise ValueError("画板已有新版本，本任务未覆盖，请重新提交")
            self.update(job, phase="发布中")
            results = []
            def track(path):
                job.setdefault("publish_paths", []).append(str(path))
                self.save(job)
            for board, assets, package, sketch_version in rendered:
                package_id, package_hash = self.sources.store(db, package, board["sketch_id"], sketch_version, user["id"], app.utc_now())
                board = {**board, "source_package_id": package_id, "source_package_hash": package_hash}
                def source():
                    for asset, path in assets:
                        yield asset, path.read_bytes()
                results.append(app.DesignHubHandler._store_artboard(None, db, user, job["project_id"], job["folder_id"], board, source, track))
            db.execute("INSERT INTO snapshot_commits VALUES (?, ?, ?)", (job["id"], json.dumps(results), time.time()))
            now = app.utc_now()
            db.execute("UPDATE folders SET updated_at=? WHERE id=?", (now, job["folder_id"]))
            db.execute("UPDATE projects SET updated_at=? WHERE id=?", (now, job["project_id"]))
            db.commit()
            self.update(job, state="complete", phase="已完成", results=results)

    def worker(self):
        while not self.stopping.is_set():
            try:
                key = self.pending.get(timeout=30)
            except queue.Empty:
                with self.lock:
                    for job in list(self.jobs.values()):
                        if job["state"] == "receiving" and not job.get("transferring") and time.time() - job["updated"] > 3600:
                            self.cancel(job)
                        if job["state"] in TERMINAL:
                            self.cleanup(job)
                            if time.time() - job["updated"] > 86400:
                                shutil.rmtree(self.root / job["id"])
                                del self.jobs[job["id"]]
                                self.space_checks.pop(job["id"], None)
                                with self.app.db_connection() as db:
                                    db.execute("DELETE FROM snapshot_commits WHERE id=?", (job["id"],))
                continue
            if key is None:
                self.pending.task_done()
                return
            job = self.jobs.get(key)
            if job is None:
                self.pending.task_done()
                continue
            try:
                with self.lock:
                    if job["state"] != "queued":
                        continue
                    self.update(job, state="rendering", phase="解析中")
                self.publish(job, self.render(job))
            except Cancelled:
                self.update(job, state="cancelled", phase="已取消")
            except Exception as error:
                # 不向客户端暴露进程参数、文件系统路径或凭据。
                message = str(error) if isinstance(error, ValueError) else "服务端处理失败，旧版本不变"
                self.update(job, state="failed", phase="失败", error=message)
            finally:
                self.cleanup(job)
                self.pending.task_done()

    def route(self, handler, method, project_id, user, job_id=None, action=None):
        if job_id is None:
            if method == "POST":
                if int(handler.headers.get("Content-Length", "0")) > 16 * 1024**2:
                    raise self.app.ApiError(413, "快照标注清单超过16MB，请减少单次画板数量")
                return handler._json(201, self.create(user, project_id, handler._read_json()))
            if method == "GET":
                with self.lock:
                    jobs = [self.public(j) for j in self.jobs.values() if j["project_id"] == project_id and j["user_id"] == user["id"]]
                return handler._json(200, {"jobs": sorted(jobs, key=lambda j: j["created"], reverse=True)[:100]})
        with self.lock:
            job = self.jobs.get(job_id)
            if not job or job["project_id"] != project_id:
                raise self.app.ApiError(404, "任务不存在")
        self.authorize(job, user)
        if method == "GET" and action is None:
            with self.lock:
                return handler._json(200, self.public(job))
        if method == "POST" and action == "file":
            return handler._json(200, self.receive(handler, job))
        if method == "POST" and action == "cancel":
            return handler._json(200, self.cancel(job))
        raise self.app.ApiError(405, "任务操作不支持")
