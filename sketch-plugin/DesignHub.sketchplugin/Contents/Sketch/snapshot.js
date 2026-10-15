// 快照传输使用系统 curl 子进程；大文件和网络等待不进入 Sketch 主线程。
const sketch = require("sketch");
const UI = require("sketch/ui");
const timers = require("timers");
const fm = NSFileManager.defaultManager();

function mkdir(path) { fm.createDirectoryAtPath_withIntermediateDirectories_attributes_error(path, true, {NSFilePosixPermissions: 448}, null); }
function write(path, value) {
  mkdir(String(NSString.stringWithString(path).stringByDeletingLastPathComponent()));
  if (!NSString.stringWithString(value).writeToFile_atomically_encoding_error(path, true, NSUTF8StringEncoding, null)) throw new Error("无法写入快照临时文件");
  fm.setAttributes_ofItemAtPath_error({NSFilePosixPermissions: 384}, path, null);
}
function read(path) { return String(NSString.stringWithContentsOfFile_encoding_error(path, NSUTF8StringEncoding, null) || ""); }
function json(path) { return JSON.parse(read(path)); }

// 保留选中画板和传递依赖的 Symbol，原文件和未选页面只存在于本地临时目录。
function trimSnapshot(source, target, ids) {
  const document = json(source + "/document.json");
  const meta = json(source + "/meta.json");
  const pages = document.pages.map((entry) => ({entry, page: json(source + "/" + entry._ref + ".json")}));
  const symbols = new Map();
  function index(layer) { if (layer._class === "symbolMaster") symbols.set(layer.symbolID, layer); (layer.layers || []).forEach(index); }
  pages.forEach(({page}) => (page.layers || []).forEach(index));
  (document.foreignSymbols || []).forEach((foreign) => { if (foreign.symbolMaster) index(foreign.symbolMaster); });
  const required = new Set();
  const styles = new Set();
  function dependencies(value) {
    if (!value || typeof value !== "object") return;
    Object.keys(value).forEach((key) => {
      const child = value[key];
      if ((key === "symbolID" || key === "value") && typeof child === "string" && symbols.has(child) && !required.has(child)) {
        required.add(child); dependencies(symbols.get(child));
      }
      if (key === "sharedStyleID") styles.add(child);
      dependencies(child);
    });
  }
  const selected = [];
  pages.forEach(({page}) => (page.layers || []).forEach((layer) => { if (ids.includes(layer.do_objectID)) { selected.push(layer); dependencies(layer); } }));
  if (selected.length !== ids.length) throw new Error("快照中所选画板不完整，未上传");
  document.pages = [];
  const retained = [];
  pages.forEach(({entry, page}) => {
    page.layers = (page.layers || []).filter((layer) => ids.includes(layer.do_objectID) || (layer._class === "symbolMaster" && required.has(layer.symbolID)));
    if (!page.layers.length) return;
    delete page.userInfo;
    document.pages.push(entry); retained.push(page);
    write(target + "/" + entry._ref + ".json", JSON.stringify(page));
  });
  document.foreignSymbols = (document.foreignSymbols || []).filter((foreign) => required.has(foreign.symbolMaster && foreign.symbolMaster.symbolID));
  ["layerStyles", "layerTextStyles"].forEach((key) => { if (document[key] && document[key].objects) document[key].objects = document[key].objects.filter((style) => styles.has(style.do_objectID)); });
  ["foreignLayerStyles", "foreignTextStyles"].forEach((key) => { document[key] = (document[key] || []).filter((style) => styles.has(style.localSharedStyle && style.localSharedStyle.do_objectID)); });
  delete document.userInfo;
  const refs = new Set();
  function externalFiles(value) {
    if (!value || typeof value !== "object") return;
    if (typeof value._ref === "string" && !value._ref.startsWith("pages/")) refs.add(value._ref);
    Object.values(value).forEach(externalFiles);
  }
  externalFiles(document); retained.forEach(externalFiles);
  refs.forEach((ref) => {
    if (ref.includes("..") || !/^(images|fonts)\/[A-Za-z0-9._-]+$/.test(ref)) throw new Error("快照存在不支持的外部依赖，未上传");
    mkdir(target + "/" + ref.split("/")[0]);
    if (!fm.copyItemAtPath_toPath_error(source + "/" + ref, target + "/" + ref, null)) throw new Error("快照缺少图片或字体依赖");
  });
  meta.pagesAndArtboards = {};
  retained.forEach((page) => { meta.pagesAndArtboards[page.do_objectID] = {name: page.name, artboards: {}}; page.layers.forEach((layer) => { if (ids.includes(layer.do_objectID)) meta.pagesAndArtboards[page.do_objectID].artboards[layer.do_objectID] = {name: layer.name}; }); });
  write(target + "/document.json", JSON.stringify(document));
  write(target + "/meta.json", JSON.stringify(meta));
  // Sketch 容器要求 user.json 存在；不携带原稿的窗口、选区和用户状态。
  write(target + "/user.json", "{}");
}

module.exports = function uploadSnapshot(options, completion) {
  const {token, origin, projectId, folderId, artboards, metadata, resources, confirm} = options;
  if (!confirm()) return;
  const root = String(NSTemporaryDirectory()) + "design-hub-snapshot-" + String(NSUUID.UUID().UUIDString());
  mkdir(root);
  let task = null, cancelled = false, finished = false, job = null, creating = false, saving = false;
  const window = NSWindow.alloc().initWithContentRect_styleMask_backing_defer(NSMakeRect(0, 0, 470, 150), NSTitledWindowMask, NSBackingStoreBuffered, false);
  window.setReleasedWhenClosed(false); window.setTitle("服务器处理 · 快照上传");
  const label = NSTextField.alloc().initWithFrame(NSMakeRect(20, 82, 430, 48));
  label.setEditable(false); label.setBezeled(false); label.setDrawsBackground(false);
  window.contentView().addSubview(label);
  const button = NSButton.alloc().initWithFrame(NSMakeRect(340, 20, 110, 32)); button.setTitle("取消任务"); button.setBezelStyle(NSRoundedBezelStyle);
  window.contentView().addSubview(button); window.center(); window.makeKeyAndOrderFront(null);
  function progress(text) { label.setStringValue(text); window.displayIfNeeded(); }
  function finish(text) {
    if (finished) return;
    finished = true; window.close();
    fm.removeItemAtPath_error(root, null);
    if (completion) completion(text);
    else UI.alert("快照上传", text);
  }
  function process(executable, args, callback, allowCancelled = false) {
    if (finished) return;
    if (cancelled && !allowCancelled) return cancelRemote();
    const errorPath = root + "/process-error.txt";
    write(errorPath, "");
    const handle = NSFileHandle.fileHandleForWritingAtPath(errorPath);
    task = NSTask.alloc().init(); task.setLaunchPath(executable); task.setArguments(args); task.setStandardOutput(handle); task.setStandardError(handle);
    try { task.launch(); } catch (_) { handle.closeFile(); return finish("无法启动后台传输进程"); }
    const running = task;
    function poll() {
      if (running.isRunning()) { timers.setTimeout(poll, 150); return; }
      handle.closeFile(); task = null;
      if (cancelled && !allowCancelled) return cancelRemote();
      try { callback(Number(running.terminationStatus())); } catch (error) { finish(String(error.message || error)); }
    }
    timers.setTimeout(poll, 150);
  }
  let requestIndex = 0;
  function request(method, path, body, file, callback, allowCancelled = false, extraHeaders = {}, failure = null) {
    const n = ++requestIndex; const output = root + "/response-" + n + ".json";
    // 凭据只写入私有配置文件，不出现在进程参数或日志。
    const quote = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]/g, "");
    const config = root + "/curl-" + n + ".conf";
    const extra = Object.keys(extraHeaders).map((key) => 'header = "' + quote(key) + ': ' + quote(extraHeaders[key]) + '"').join("\n");
    write(config, 'header = "Authorization: Bearer ' + quote(token) + '"\nheader = "Content-Type: ' + (file ? 'application/octet-stream' : 'application/json') + '"\n' + extra + (extra ? "\n" : ""));
    const args = ["--silent", "--show-error", "--noproxy", "*", "--connect-timeout", "10", "--max-time", file ? "1800" : "30", "--fail-with-body", "--config", config, "--request", method, "--output", output];
    if (file) args.push("--data-binary", "@" + file);
    else if (body !== null) { const payload = root + "/body-" + n + ".json"; write(payload, JSON.stringify(body)); args.push("--data-binary", "@" + payload); }
    args.push(origin + path);
    process("/usr/bin/curl", args, (code) => {
      let result = {}; try { result = json(output); } catch (_) {}
      if (code !== 0) {
        if (failure) return failure(result);
        return finish((result.error || "网络请求失败") + (job ? "\n任务 ID：" + job.id + "，可在服务端任务列表确认状态。" : ""));
      }
      callback(result);
    }, allowCancelled);
  }
  const base = "/api/projects/" + projectId + "/snapshot-jobs";
  function uploadChunks(file, size, offset = 0, attempt = 0) {
    if (cancelled) return cancelRemote();
    if (offset >= size) return pollJob();
    const length = Math.min(4 * 1024 * 1024, size - offset);
    const chunk = root + "/upload-chunk.bin";
    const input = NSFileHandle.fileHandleForReadingAtPath(file);
    input.seekToFileOffset(offset);
    const data = input.readDataOfLength(length); input.closeFile();
    if (Number(data.length()) !== length || !data.writeToFile_atomically(chunk, true)) return finish("无法读取上传分块");
    progress("后台上传源稿 " + ((offset + length) / size * 100).toFixed(0) + "%\n任务 " + job.id);
    request("POST", base + "/" + job.id + "/chunk", null, chunk, (result) => {
      fm.removeItemAtPath_error(chunk, null);
      uploadChunks(file, size, Number(result.received || offset + length), 0);
    }, false, {"X-Upload-Offset": String(offset)}, (result) => {
      if (attempt < 3) return timers.setTimeout(() => uploadChunks(file, size, offset, attempt + 1), 500 * (attempt + 1));
      finish((result.error || "源稿分块上传失败") + "\n任务 ID：" + job.id + "，可重新上传并由服务端清理未完成任务。");
    });
  }
  function cancelRemote() {
    if (creating || saving) return;
    if (!job) return finish("已取消，本次未提交渲染任务");
    progress("正在请求服务器取消…");
    request("POST", base + "/" + job.id + "/cancel", {}, null, (result) => {
      if (["cancelled", "failed"].includes(result.state)) finish("任务已停止，未完成结果不会发布");
      else if (result.state === "complete") finish("任务已完成发布，未执行取消");
      else timers.setTimeout(cancelRemote, 1000);
    }, true);
  }
  button.setCOSJSTargetFunction(() => { cancelled = true; progress("正在取消…"); if (task && task.isRunning() && !creating) task.terminate(); else if (!task) cancelRemote(); });
  function pollJob() {
    if (cancelled) return cancelRemote();
    request("GET", base + "/" + job.id, null, null, (result) => {
      progress((result.phase || result.state) + " · " + (result.done || 0) + "/" + (result.total || 0) + "\n任务 " + job.id);
      if (result.state === "complete") {
        const counts = {created: 0, updated: 0, unchanged: 0};
        result.results.forEach((item) => { if (counts[item.status] !== undefined) counts[item.status] += 1; });
        return finish("服务端处理完成 · 新增 " + counts.created + " · 更新 " + counts.updated + " · 未变化 " + counts.unchanged + "；任务快照已清理。");
      }
      if (["failed", "cancelled"].includes(result.state)) return finish(result.error || "任务已取消");
      timers.setTimeout(pollJob, 1500);
    });
  }
  try {
    const boards = artboards.map((board) => ({sketch_id: String(board.id), name: String(board.name), width: Number(board.frame.width), height: Number(board.frame.height), canvas_x: Number(board.frame.x), canvas_y: Number(board.frame.y), metadata: {artboard: metadata(board, true)}, resources: resources(board)}));
    const document = artboards[0].getParentPage().parent;
    progress("正在保存本次选区快照，尚未开始渲染…");
    saving = true;
    document.save(root + "/source.sketch", {saveMode: "SaveTo"}, (error) => {
      saving = false;
      if (error) return finish("无法保存快照：" + error.message);
      if (cancelled) return cancelRemote();
      process("/usr/bin/ditto", ["-x", "-k", root + "/source.sketch", root + "/source"], (code) => {
        if (code) return finish("无法读取快照");
        trimSnapshot(root + "/source", root + "/selected", boards.map((b) => b.sketch_id));
        progress("正在打包所选画板与依赖…");
        process("/usr/bin/ditto", ["-c", "-k", "--norsrc", root + "/selected", root + "/snapshot.sketch"], (code) => {
          if (code) return finish("快照打包失败");
          const size = Number(fm.attributesOfItemAtPath_error(root + "/snapshot.sketch", null).fileSize());
          creating = true;
          request("POST", base, {folder_id: folderId, boards, size}, null, (result) => {
            job = result; creating = false;
            if (cancelled) return cancelRemote();
            progress("后台上传源稿 " + (size / 1024 / 1024).toFixed(1) + " MB…");
            uploadChunks(root + "/snapshot.sketch", size, Number(result.received || 0));
          }, true);
        });
      });
    });
  } catch (error) { finish(String(error.message || error)); }
};
