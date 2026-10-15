const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(require('node:path').join(__dirname, '../sketch-plugin/DesignHub.sketchplugin/Contents/Sketch/script.js'), 'utf8');
const snapshotSource = fs.readFileSync(require('node:path').join(__dirname, '../sketch-plugin/DesignHub.sketchplugin/Contents/Sketch/snapshot.js'), 'utf8');
assert(!source.includes('require("./local-upload")'),'新插件不得再进入本地资源处理');
assert(snapshotSource.includes('uploadChunks') && snapshotSource.includes('/chunk'),'新插件必须使用分块源稿上传');
assert(snapshotSource.includes('counts[item.status]') && snapshotSource.includes('未变化 '),'完成提示必须区分新增、更新和未变化');
const projectId = '11111111-1111-1111-1111-111111111111';
const folderId = '22222222-2222-2222-2222-222222222222';
function run(valid, confirmed = true) {
  const calls = [], alerts = [], dispatched = [];
  let configuredOrigin = 'http://first-server:8765';
  const context = vm.createContext({console, require(name) {
    if (name === './local-upload' || name === './snapshot') return options => dispatched.push({name,options});
    if (name === 'sketch/ui') return {message() {}, alert: (...args) => alerts.push(args)};
    if (name === 'sketch/settings') return {settingForKey: () => configuredOrigin};
    return {};
  }});
  vm.runInContext(source, context);
  Object.assign(context, {project: {id: valid ? projectId : undefined, name: 'project'}, folder: {id:folderId, name:'folder'}, calls, projectId, folderId});
  vm.runInContext(`
    confirmServerUpload = () => ${JSON.stringify(confirmed)};
    request = (method, path, body, token, selectedOrigin) => {
      calls.push({path,body,token,selectedOrigin});
      return {snapshot_upload_enabled:true,parallel_upload_enabled:true,source_upload_protocol:2,processing_mode:'server'};
    };
    uploadWithProcessingMode('test-token',project,folder,[{id:'board',name:'board'}]);
    // 回调退出后即使原对象不再提供 ID，后续任务仍必须使用已选目标。
    delete project.id; delete folder.id;
  `, context);
  configuredOrigin = 'http://another-server:8765';
  if (valid && confirmed) {
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, '/api/me');
    assert(calls.every(c => c.token === 'test-token' && !c.path.includes('undefined')));
    assert(calls.every(c => c.selectedOrigin === 'http://first-server:8765'));
    assert.equal(dispatched.length,1);
    assert.equal(dispatched[0].name,'./snapshot');
    assert.equal(dispatched[0].options.projectId,projectId);
    assert.equal(dispatched[0].options.folderId,folderId);
    assert.equal(dispatched[0].options.origin,'http://first-server:8765');
    assert.equal(dispatched[0].options.token,'test-token');
  } else {
    assert.equal(calls.length, 0);
    assert.equal(dispatched.length,0);
    assert.equal(alerts.length, valid ? 0 : 1);
    if (!valid) assert.equal(alerts[0][0], '无法上传');
  }
}
run(true); run(true,false); run(false);
for (const mode of ['same','changed','cancel','invalid']) {
  const values = {'designHub.serverURL':'http://first-server:8765','designHub.sessionToken':'existing-token'};
  let input, called=0;
  const ctx=vm.createContext({require(name) {
    if(name==='sketch/settings')return {settingForKey:key=>values[key],setSettingForKey:(key,value)=>{values[key]=value;}};
    if(name==='sketch/ui')return {getInputFromUser:(_,options,callback)=>{input=callback;},alert(){}};
    return {};
  }, selected:()=>{called++;}});
  vm.runInContext(source,ctx); vm.runInContext('chooseUploadServer(selected)',ctx);
  input(mode==='cancel' ? new Error('cancel') : null,mode==='changed'?'http://10.104.19.105:8765':mode==='invalid'?'invalid':'http://first-server:8765');
  assert.equal(called,['cancel','invalid'].includes(mode)?0:1);
  assert.equal(values['designHub.sessionToken'],mode==='changed'?undefined:'existing-token');
  assert.equal(values['designHub.serverURL'],mode==='changed'?'http://10.104.19.105:8765':'http://first-server:8765');
}
console.log('PASS: 每次上传选择服务器、取消不继续、切换清令牌、在途批次固定目标');
for (const saved of ['', 'http://saved-server:8765']) {
  const ctx=vm.createContext({require(name){return name==='sketch/settings'?{settingForKey:()=>saved}:{};}});
  vm.runInContext(source.replace('const BUNDLED_SERVER_URL = "";', 'const BUNDLED_SERVER_URL = "http://10.104.19.105:8765";'),ctx);
  assert.equal(vm.runInContext('serverURL()',ctx),saved || 'http://10.104.19.105:8765');
  for(const bad of ['http://user:password@server','http://server/path','http://server:99999','javascript:alert(1)','']) {
    ctx.bad=bad; assert.throws(()=>vm.runInContext('normalizeServerURL(bad)',ctx));
  }
}
console.log('PASS: 下载内置地址、手动地址优先、非法服务地址拒绝');
console.log('PASS: 目标ID跨定时器保持、目录快照、无效目标一次拦截且无请求');

// 纯对象回归，不启动 Sketch、不访问网络或修改设计稿。
{
  let selected = [];
  const ctx = vm.createContext({require(name) {
    return name === 'sketch' ? {getSelectedDocument: () => ({selectedLayers: {layers: selected}})} : {};
  }});
  vm.runInContext(source, ctx);
  const page = {type:'Page'};
  const board = {id:'board',type:'Artboard',parent:page,layers:[],exportFormats:[{fileFormat:'png'}]};
  function child(parent, id, type, extras = {}) {
    const layer = {id,name:id,type,parent,layers:[],...extras};
    parent.layers.push(layer); return layer;
  }
  const slice = child(board,'slice','Group',{exportFormats:[{fileFormat:'png'}]});
  const inner = child(slice,'inner','Group',{exportFormats:[{fileFormat:'png'}]});
  const text = child(inner,'label','ShapePath');
  const hidden = child(board,'hidden','Group',{hidden:true});
  const hiddenChild = child(hidden,'hidden-child','Shape');
  const ordinary = child(board,'ordinary','Group');
  const shape = child(ordinary,'shape','Shape');
  child(shape,'boolean-path','ShapePath');
  const empty = child(board,'empty','Group');
  const hiddenOnly = child(board,'hidden-only','Group');
  child(hiddenOnly,'hidden-content','Image',{hidden:true});
  const nested = child(board,'nested','Artboard');
  const nestedChild = child(nested,'nested-child','Shape');
  Object.assign(ctx,{board,slice,text,hiddenChild,nestedChild,shape,empty,hiddenOnly});
  const evaluate = code => vm.runInContext(code,ctx);
  assert.equal(evaluate('collectAssetLayers(board).map(layer=>layer.id).join()'),'board,slice,ordinary,shape,nested-child');
  assert.equal(evaluate('layerMetadata(board,true).layers.some(layer=>layer.id === "hidden")'),false);
  assert.equal(evaluate('layerMetadata(board,true).layers.length'),3,'保留界面内容，排除空和隐藏分支');
  assert.equal(evaluate('layerMetadata(slice).layers.length'),0,'整体切图内部不再保留独立标注');
  assert.equal(evaluate('layerMetadata(shape).layers.length'),0,'布尔形状内部路径不作为独立标注');
  assert.equal(evaluate('layerMetadata(empty)'),null);
  assert.equal(evaluate('layerMetadata(hiddenOnly)'),null);
  text.style = {shadows:[{enabled:true}]};
  assert.equal(evaluate('layerMetadata(slice).hasDescendantShadows'),true,'收拢标注不丢失无阴影资源能力');
  text.type = 'Text';
  assert.equal(evaluate('layerMetadata(slice).layers[0].layers[0].id'),'label','含嵌套文字的切图容器必须保留文字标注');
  assert.equal(evaluate('collectAssetLayers(board).map(layer=>layer.id).join()'),'board,slice,inner,label,ordinary,shape,nested-child','卡片整体资源与文字资源同时保留');
  text.hidden = true;
  assert.equal(evaluate('isAtomicLayer(slice)'),true,'隐藏文字不改变图标边界');
  text.hidden = false;
  assert.equal(evaluate('layerMetadata(hiddenChild)'),null);
  assert.equal(evaluate('collectAssetLayers(hiddenChild).length'),0);
  assert.equal(evaluate('findArtboard(nestedChild)'),board);
  assert.equal(evaluate('findArtboard(hiddenChild)'),null);
  selected = [board,nestedChild,text,hiddenChild];
  assert.equal(evaluate('selectedArtboards().map(layer=>layer.id).join()'),'board');
  board.hidden = true;
  assert.equal(evaluate('selectedArtboards().length'),0);
  assert.throws(()=>evaluate('buildPayload(board,"folder")'),/隐藏/);
  assert.throws(()=>evaluate('exportLayerFiles(text,"unused")'),/隐藏/);
  assert.equal(evaluate('enabledShadows(board).length'),0);
}
console.log('PASS: 隐藏过滤、整体标注及切图边界、空分组排除、阴影保留、嵌套画框归属和画板去重');
