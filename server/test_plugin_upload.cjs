const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(require('node:path').join(__dirname, '../sketch-plugin/DesignHub.sketchplugin/Contents/Sketch/script.js'), 'utf8');
const projectId = '11111111-1111-1111-1111-111111111111';
const folderId = '22222222-2222-2222-2222-222222222222';
function run(valid) {
  const jobs = [], calls = [], alerts = [];
  let configuredOrigin = 'http://first-server:8765';
  const context = vm.createContext({console, require(name) {
    if (name === 'timers') return {setTimeout: fn => jobs.push(fn)};
    if (name === 'sketch/ui') return {message() {}, alert: (...args) => alerts.push(args)};
    if (name === 'sketch/settings') return {settingForKey: () => configuredOrigin};
    return {};
  }});
  vm.runInContext(source, context);
  Object.assign(context, {project: {id: valid ? projectId : undefined, name: 'project'}, folder: {id:folderId, name:'folder'}, calls, projectId, folderId});
  vm.runInContext(`
    confirmUpload = () => true;
    uploadProgress = () => ({update(){}, finish(){}, close(){}});
    buildPayload = (board, id) => {
      if(id !== folderId) throw new Error('目录快照失效');
      return {artboards:[{sketch_id:board.id}]};
    };
    collectAssetLayers = () => [];
    request = (method, path, body, token, selectedOrigin) => {
      calls.push({path,body,token,selectedOrigin});
      if(path.endsWith('/commit')) return {results:[{sketch_id:'board',status:'updated'}]};
      return {upload_id:'33333333-3333-3333-3333-333333333333'};
    };
    uploadToFolder('test-token',project,folder,[{id:'board',name:'board'}]);
    // 回调退出后即使原对象不再提供 ID，后续任务仍必须使用已选目标。
    delete project.id; delete folder.id;
  `, context);
  configuredOrigin = 'http://another-server:8765';
  while (jobs.length) jobs.shift()();
  if (valid) {
    assert.equal(calls.length, 2);
    assert.equal(calls[0].path, `/api/projects/${projectId}/uploads`);
    assert.equal(calls[0].body.folder_id, folderId);
    assert(calls.every(c => c.token === 'test-token' && !c.path.includes('undefined')));
    assert(calls.every(c => c.selectedOrigin === 'http://first-server:8765'));
    assert(alerts[0][1].includes('更新 1'));
  } else {
    assert.equal(calls.length, 0);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0][0], '无法开始上传');
  }
}
run(true); run(false);
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
