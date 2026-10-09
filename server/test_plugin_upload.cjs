const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(require('node:path').join(__dirname, '../sketch-plugin/DesignHub.sketchplugin/Contents/Sketch/script.js'), 'utf8');
const projectId = '11111111-1111-1111-1111-111111111111';
const folderId = '22222222-2222-2222-2222-222222222222';
function run(valid) {
  const jobs = [], calls = [], alerts = [];
  const context = vm.createContext({console, require(name) {
    if (name === 'timers') return {setTimeout: fn => jobs.push(fn)};
    if (name === 'sketch/ui') return {message() {}, alert: (...args) => alerts.push(args)};
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
    request = (method, path, body, token) => {
      calls.push({path,body,token});
      if(path.endsWith('/commit')) return {results:[{sketch_id:'board',status:'updated'}]};
      return {upload_id:'33333333-3333-3333-3333-333333333333'};
    };
    uploadToFolder('test-token',project,folder,[{id:'board',name:'board'}]);
    // 回调退出后即使原对象不再提供 ID，后续任务仍必须使用已选目标。
    delete project.id; delete folder.id;
  `, context);
  while (jobs.length) jobs.shift()();
  if (valid) {
    assert.equal(calls.length, 2);
    assert.equal(calls[0].path, `/api/projects/${projectId}/uploads`);
    assert.equal(calls[0].body.folder_id, folderId);
    assert(calls.every(c => c.token === 'test-token' && !c.path.includes('undefined')));
    assert(alerts[0][1].includes('更新 1'));
  } else {
    assert.equal(calls.length, 0);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0][0], '无法开始上传');
  }
}
run(true); run(false);
console.log('PASS: 目标ID跨定时器保持、目录快照、无效目标一次拦截且无请求');
