// 本地原生导出仍在主线程小步执行；网络由最多两个独立 curl 进程处理。
const UI = require("sketch/ui");
const sketch = require("sketch");
const timers = require("timers");
const fm = NSFileManager.defaultManager();
const LIMIT = 4 * 1024 * 1024;

function splitAssets(assets) {
  const batches = []; let batch = [], bytes = 0;
  for (const asset of assets) {
    const size = JSON.stringify(asset).length;
    if (batch.length && (batch.length >= 24 || bytes + size > LIMIT)) { batches.push(batch); batch = []; bytes = 0; }
    batch.push(asset); bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

module.exports = function uploadLocal(options, completion) {
  const {origin, token, projectId, folderId, artboards, buildPayload, collectLayers, exportLayer} = options;
  const documentId = String(artboards[0].getParentPage().parent.id);
  const root = String(NSTemporaryDirectory()) + "design-hub-local-" + String(NSUUID.UUID().UUIDString());
  fm.createDirectoryAtPath_withIntermediateDirectories_attributes_error(root, true, {NSFilePosixPermissions:448}, null);
  let requestId = 0, boardIndex = 0, uploadId = null, layerIndex = 0, chunks = 0, assets = 0, uploaded = 0, lastProgress = 0;
  let layers = [], pending = [], buffer = [], bufferBytes = 0, cancelled = false, error = null, finishing = false, closed = false, starting = false, committing = false;
  const active = new Set(); const results = [];
  const base = "/api/projects/" + projectId + "/uploads";
  const window = NSWindow.alloc().initWithContentRect_styleMask_backing_defer(NSMakeRect(0,0,480,160), NSTitledWindowMask, NSBackingStoreBuffered, false);
  window.setReleasedWhenClosed(false); window.setTitle("本地处理 · 后台并行上传");
  const label = NSTextField.alloc().initWithFrame(NSMakeRect(20,82,440,58)); label.setEditable(false); label.setBezeled(false); label.setDrawsBackground(false);
  const bar = NSProgressIndicator.alloc().initWithFrame(NSMakeRect(20,60,440,14)); bar.setIndeterminate(false); bar.setMinValue(0); bar.setMaxValue(100);
  const cancel = NSButton.alloc().initWithFrame(NSMakeRect(350,15,110,32)); cancel.setTitle("取消上传"); cancel.setBezelStyle(NSRoundedBezelStyle);
  window.contentView().addSubview(label); window.contentView().addSubview(bar); window.contentView().addSubview(cancel); window.center(); window.makeKeyAndOrderFront(null);
  function write(path, text) {
    if (!NSString.stringWithString(text).writeToFile_atomically_encoding_error(path,true,NSUTF8StringEncoding,null)) throw new Error("无法写入上传暂存文件");
    fm.setAttributes_ofItemAtPath_error({NSFilePosixPermissions:384},path,null);
  }
  function refresh(phase) {
    const fraction = layers.length ? Math.min(layerIndex / layers.length * .8 + (assets ? uploaded / assets : 0) * .19, .99) : 0;
    lastProgress = Math.max(lastProgress, (boardIndex + fraction) / artboards.length * 100);
    bar.setDoubleValue(lastProgress);
    label.setStringValue(`${phase || "导出并上传"} · ${boardIndex + 1}/${artboards.length}\n图层 ${layerIndex}/${layers.length} · 资源已上传 ${uploaded} · 已组包 ${assets} · 并行 ${active.size}/2`);
    window.displayIfNeeded();
  }
  function finish(message) {
    if (closed) return;
    closed = true; window.close(); fm.removeItemAtPath_error(root,null);
    if (completion) completion(message, results); else UI.alert("本地上传",message);
  }
  function request(path, body, callback) {
    const id = ++requestId; const files = ["body","config","response","error"].map(name => `${root}/${name}-${id}`);
    write(files[0],JSON.stringify(body)); write(files[3],"");
    const safe = value => String(value).replace(/\\/g,"\\\\").replace(/"/g,'\\"').replace(/[\r\n]/g,"");
    write(files[1],`header = "Authorization: Bearer ${safe(token)}"\nheader = "Content-Type: application/json"\n`);
    const handle = NSFileHandle.fileHandleForWritingAtPath(files[3]);
    const task = NSTask.alloc().init(); task.setLaunchPath("/usr/bin/curl");
    task.setArguments(["--silent","--show-error","--noproxy","*","--connect-timeout","10","--max-time","120","--fail-with-body","--config",files[1],"--request","POST","--data-binary","@"+files[0],"--output",files[2],origin+path]);
    task.setStandardOutput(handle);task.setStandardError(handle);
    try { task.launch(); } catch (_) { handle.closeFile(); return callback(new Error("无法启动后台上传")); }
    active.add(task);
    function poll() {
      if (task.isRunning()) { timers.setTimeout(poll,100); return; }
      handle.closeFile(); active.delete(task);
      let response = {}; try { response = JSON.parse(String(NSString.stringWithContentsOfFile_encoding_error(files[2],NSUTF8StringEncoding,null))); } catch (_) {}
      files.forEach(file=>fm.removeItemAtPath_error(file,null));
      try { callback(Number(task.terminationStatus()) ? new Error(response.error || "上传请求失败") : null,response); }
      catch (e) { fail(e); }
    }
    timers.setTimeout(poll,100);
  }
  function fail(reason) { if (!error) error=reason; stop(); }
  function stop() {
    if (finishing || closed) return;
    pending=[];buffer=[];bufferBytes=0;
    // 创建任务必须先等到ID，提交阶段不可伪称取消成功。
    if (starting || committing) return;
    for (const task of active) if (task.isRunning()) task.terminate();
    if (active.size) { timers.setTimeout(stop,100);return; }
    if (finishing || closed) return;
    finishing=true;
    const message = `${cancelled ? "已取消" : "上传失败：" + (error && error.message)}。已完成 ${results.length}/${artboards.length} 个画板；之前完成的版本保留。`;
    if (!uploadId) return finish(message);
    request(base+"/"+uploadId+"/cancel",{},(failure)=>finish(message+(failure ? "\n远端取消尚未确认，暂存将按服务端过期规则清理。" : "\n当前画板暂存已清理。")));
  }
  cancel.setCOSJSTargetFunction(()=>{if(committing)return;cancelled=true;cancel.setEnabled(false);refresh("正在取消");stop();});
  function flush() {
    for(const batch of splitAssets(buffer)) { pending.push({index:chunks++,assets:batch}); assets+=batch.length; }
    buffer=[];bufferBytes=0;
  }
  function drain() {
    if (closed || finishing) return;
    if (cancelled || error) return stop();
    while(active.size<2 && pending.length) {
      const batch=pending.shift();
      request(base+"/"+uploadId+"/chunk",batch,(failure,ack)=>{
        if(cancelled||error)return stop();
        if(failure)return fail(failure);
        if(ack.index!==batch.index || ack.received!==batch.assets.length)return fail(new Error("服务端批次确认不完整"));
        uploaded+=ack.received;refresh();drain();
      });
    }
    if(layerIndex===layers.length && !pending.length && !active.size && !buffer.length && !committing) {
      committing=true;cancel.setEnabled(false);refresh("正在发布当前画板");
      request(base+"/"+uploadId+"/commit",{chunks,assets},(failure,response)=>{
        committing=false;
        if(failure) return finish("发布结果未确认，请刷新网页核对后再重试。已完成 "+results.length+" 个画板。");
        const item=response.results && response.results[0];
        if(!item || response.results.length!==1 || item.sketch_id!==String(artboards[boardIndex].id) || !["created","updated","unchanged"].includes(item.status))return fail(new Error("服务端未确认当前画板"));
        results.push(item);uploadId=null;boardIndex++;
        if(boardIndex===artboards.length)return finish(`本地处理完成，${results.length} 个画板已上传。`);
        cancel.setEnabled(true);timers.setTimeout(nextBoard,20);
      });
    }
  }
  function exportNext() {
    if(closed||committing)return;
    if(cancelled||error)return stop();
    if(pending.length>=2){timers.setTimeout(exportNext,50);return;}
    try {
      if (!sketch.getDocuments().some(doc=>String(doc.id)===documentId)) throw new Error("源文档已关闭，已停止本地导出");
      if(layerIndex<layers.length) {
        const directory=root+"/layer-"+boardIndex+"-"+layerIndex;
        fm.createDirectoryAtPath_withIntermediateDirectories_attributes_error(directory,true,null,null);
        try {
          const batch=exportLayer(layers[layerIndex],directory);
          if(!batch.length)throw new Error("图层没有导出资源");
          buffer.push(...batch);bufferBytes+=JSON.stringify(batch).length;
        } finally {fm.removeItemAtPath_error(directory,null);}
        layerIndex++;
      }
      if(buffer.length>=24||bufferBytes>=LIMIT||layerIndex===layers.length)flush();
      refresh();drain();
      if(layerIndex<layers.length)timers.setTimeout(exportNext,20);
    } catch(e){fail(e);}
  }
  function nextBoard() {
    if (closed) return;
    if(cancelled||error)return stop();
    layerIndex=0;chunks=0;assets=0;uploaded=0;pending=[];buffer=[];bufferBytes=0;layers=[];
    refresh("准备当前画板");
    try {
      if (!sketch.getDocuments().some(doc=>String(doc.id)===documentId)) throw new Error("源文档已关闭，已停止本地导出");
      const board=artboards[boardIndex]; const payload=buildPayload(board,folderId);layers=collectLayers(board);starting=true;
      request(base,{folder_id:folderId,board:payload.artboards[0],parallel_chunks:true},(failure,response)=>{
        starting=false;
        if(failure)return fail(failure);
        uploadId=response.upload_id;
        if(!/^[0-9a-f-]{36}$/i.test(uploadId||""))return fail(new Error("上传任务ID无效"));
        if(cancelled||error)return stop();
        timers.setTimeout(exportNext,20);
      });
    }catch(e){starting=false;fail(e);}
  }
  timers.setTimeout(nextBoard,20);
};

module.exports.splitAssets=splitAssets;
