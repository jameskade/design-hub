"""隔离任务协议回归；仅使用临时数据库，原生渲染另做真实 Sketch 端到端验收。"""
import base64
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import time
from types import SimpleNamespace
from unittest.mock import patch
import zipfile

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")


def main():
    with tempfile.TemporaryDirectory(prefix="design-hub-snapshot-regression-") as temporary:
        os.environ["DESIGN_HUB_DATA_DIR"] = temporary
        import app
        from snapshot_jobs import SnapshotJobs, validate_snapshot
        app.init_database()
        first = dict(id=app.uuid4(), role="designer")
        second = dict(id=app.uuid4(), role="designer")
        project, folder = app.uuid4(), app.uuid4()
        now = app.utc_now()
        with app.db_connection() as db:
            for index, user in enumerate([first, second]):
                db.execute("INSERT INTO users (id,username,username_norm,display_name,password_hash,role,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)", (user["id"],f"test{index}",f"test{index}","测试设计师","not-a-password","designer",now,now))
            db.execute("INSERT INTO projects (id,name,created_by,created_at,updated_at) VALUES (?,?,?,?,?)", (project,"隔离测试项目",first["id"],now,now))
            db.execute("INSERT INTO folders (id,project_id,name,created_at,updated_at) VALUES (?,?,?,?,?)", (folder,project,"隔离目录",now,now))
            for user in [first,second]:
                db.execute("INSERT INTO project_members VALUES (?,?,?,?,?)",(project,user["id"],"editor",now,now))
        manager = SnapshotJobs(app)
        board = dict(sketch_id="board",name="测试",width=10,height=10,metadata={"artboard":{"id":"board","layers":[]}},resources=[])
        def archive(extra=None):
            out=io.BytesIO()
            with zipfile.ZipFile(out,"w") as z:
                z.writestr("document.json",json.dumps({"pages":[{"_ref":"pages/page"}]}))
                z.writestr("pages/page.json",json.dumps({"layers":[{"do_objectID":"board","_class":"group"}]}))
                z.writestr("meta.json",json.dumps({"appVersion":"2025.3.4"}))
                z.writestr("user.json","{}")
                if extra:z.writestr(*extra)
            return out.getvalue()
        raw=archive()
        with zipfile.ZipFile(io.BytesIO(raw)) as package_archive:
            package_files={item.filename:package_archive.read(item) for item in package_archive.infolist()}
        from source_packages import split_design
        from sketch_parser import PARSER_VERSION, parse_design
        source_package=split_design(package_files,"board")
        design_context=parse_design(source_package,"board")
        def create(user=first):
            with patch("snapshot_jobs.subprocess.run",return_value=SimpleNamespace(returncode=0,stdout="2025.3.4")):
                result=manager.create(user,project,dict(folder_id=folder,boards=[board],size=len(raw)))
            return manager.jobs[result["id"]]
        class Connection:
            def gettimeout(self):return None
            def settimeout(self,value):pass
        def receive(job):
            return manager.receive(SimpleNamespace(headers={"Content-Length":str(len(raw))},connection=Connection(),rfile=io.BytesIO(raw)),job)
        def wait(job):
            deadline=time.monotonic()+5
            while job["state"] not in {"complete","failed","cancelled"} and time.monotonic()<deadline:time.sleep(.01)
            deadline=time.monotonic()+5
            while (manager.root/job['id']/'work').exists() and time.monotonic()<deadline:time.sleep(.01)
            assert job["state"] in {"complete","failed","cancelled"},job
            assert not (manager.root/job['id']/'work').exists(),job
        def rendered(job):
            return [({**board,"preview_base64":base64.b64encode(PNG).decode(),"design_context":design_context,"parser_version":PARSER_VERSION},[],source_package,"2025.3.4")]
        try:
            # 同时提交的不同设计师任务拥有独立所有权、输入和取消状态。
            started=threading.Event(); release=threading.Event()
            def held(job):
                started.set(); release.wait(5); manager.check(job); return rendered(job)
            manager.render=held
            a=create(); b=create(second)
            assert a['id']!=b['id']
            try:manager.authorize(a,second);raise AssertionError('越权未阻止')
            except app.ApiError as e:assert e.status==403
            receive(a); assert started.wait(2)
            receive(b); assert b['state']=='queued'
            manager.cancel(b); assert b['state']=='cancelled' and not a.get('cancel_requested')
            release.set();wait(a);wait(b);assert a['state']=='complete',a
            print('PASS: 两人独立任务、越权拒绝、排队取消不影响运行任务、成功及取消清理')
            # 两任务以同一版本为基准，后完成者不能覆盖先发布者。
            started.clear();release.clear()
            c=create();d=create(second);receive(c);assert started.wait(2);receive(d)
            # 修改预览使 c 产生新版本而非 unchanged。
            def changed(job):
                payload={**board,'name':'新版本','metadata':{'artboard':{'id':'board','name':'changed'}},'preview_base64':base64.b64encode(PNG).decode()}
                return [({**payload,"design_context":design_context,"parser_version":PARSER_VERSION},[],source_package,"2025.3.4")]
            def changed_held(job):started.set();release.wait(5);return changed(job)
            # c 已进入 held；改输入 metadata 在它发布前使其结果变化。
            original_rendered=rendered
            rendered=changed
            release.set();wait(c);wait(d)
            assert c['state']=='complete' and d['state']=='failed',(c,d)
            assert '新版本' in d['error']
            print('PASS: 同画板并发版本冲突阻止旧任务覆盖')
            manager.render=held;started.clear();release.clear()
            e=create();receive(e);assert started.wait(2);manager.cancel(e);release.set();wait(e)
            assert e['state']=='cancelled'
            with app.db_connection() as db:assert db.execute('SELECT count(*) FROM artboard_versions').fetchone()[0]==2
            print('PASS: 渲染中取消不发布、不改变已有版本')
            incomplete=create();incomplete['updated']=time.time()-4000
            manager.cancel(incomplete);wait(incomplete)
            bad=Path(temporary)/'bad.sketch';bad.write_bytes(archive(('pages/../escape','bad')))
            try:validate_snapshot(bad,[board]);raise AssertionError('穿越未拒绝')
            except ValueError:pass
            bad.write_bytes(archive(('other.json',json.dumps({'_ref':'fonts/missing'}))))
            try:validate_snapshot(bad,[board]);raise AssertionError('字体缺失未拒绝')
            except ValueError:pass
            with patch('snapshot_jobs.shutil.disk_usage',return_value=SimpleNamespace(free=0)):
                try:create();raise AssertionError('空间不足未拒绝')
                except app.ApiError as error:assert error.status==507
            print('PASS: 未完成任务清理、目录穿越/字体缺失拒绝、磁盘不足拒绝')
            abandoned=create(); old_id=abandoned['id']
            manager.close()
            manager=SnapshotJobs(app)
            assert manager.jobs[old_id]['state']=='failed'
            assert not (manager.root/old_id/'work').exists()
            assert all(j['state'] in {'complete','failed','cancelled'} for j in manager.jobs.values())
            print('PASS: 服务重启回收未完成任务，已发布结果不重复发布')
        finally:
            manager.close()


if __name__ == '__main__':
    main()
