// 直接执行插件中的裁剪函数，模拟文件桥接，不启动 Sketch 或访问业务数据。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const code = fs.readFileSync(path.join(__dirname,'../sketch-plugin/DesignHub.sketchplugin/Contents/Sketch/snapshot.js'),'utf8');
const declaration = code.slice(code.indexOf('function trimSnapshot('),code.indexOf('module.exports ='));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'design-hub-snapshot-pack-'));
try {
  const source=path.join(root,'source'), target=path.join(root,'selected');
  const write=(p,value)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,value);};
  const json=(p)=>JSON.parse(fs.readFileSync(p,'utf8'));
  const put=(name,value)=>write(path.join(source,name),JSON.stringify(value));
  put('document.json',{pages:[{_ref:'pages/design'},{_ref:'pages/symbols'}],fontReferences:[{fontData:{_ref:'fonts/embedded-font'}}],layerStyles:{objects:[]}});
  put('meta.json',{appVersion:'2025.3.4'});
  put('pages/design.json',{do_objectID:'page',layers:[{do_objectID:'selected',layers:[{_class:'symbolInstance',symbolID:'symbol-a'}]},{do_objectID:'private-board',name:'不允许上传'}]});
  put('pages/symbols.json',{do_objectID:'symbols-page',layers:[
    {_class:'symbolMaster',do_objectID:'master-a',symbolID:'symbol-a',layers:[{symbolID:'symbol-b'}]},
    {_class:'symbolMaster',do_objectID:'master-b',symbolID:'symbol-b',layers:[{image:{_ref:'images/picture.png'}}]},
    {_class:'symbolMaster',do_objectID:'unused',symbolID:'unused-symbol'}
  ]});
  write(path.join(source,'images/picture.png'),'image-fixture');write(path.join(source,'fonts/embedded-font'),'font-fixture');
  const context=vm.createContext({json,write,mkdir:p=>fs.mkdirSync(p,{recursive:true}),fm:{copyItemAtPath_toPath_error:(a,b)=>{fs.copyFileSync(a,b);return true;}},source,target});
  vm.runInContext(declaration,context);
  vm.runInContext('trimSnapshot(source,target,["selected"])',context);
  assert.equal(json(path.join(target,'pages/design.json')).layers.length,1);
  assert.deepEqual(json(path.join(target,'pages/symbols.json')).layers.map(l=>l.symbolID),['symbol-a','symbol-b']);
  assert.equal(fs.readFileSync(path.join(target,'fonts/embedded-font'),'utf8'),'font-fixture');
  assert.equal(fs.readFileSync(path.join(target,'images/picture.png'),'utf8'),'image-fixture');
  assert.deepEqual(json(path.join(target,'user.json')),{});
  assert.equal(json(path.join(source,'pages/design.json')).layers.length,2,'原稿结构不改写');
  assert.throws(()=>vm.runInContext('trimSnapshot(source,target,["missing"])',context),/不完整/);
  console.log('PASS: 选中画板过滤、传递组件依赖、嵌入字体/图片、user.json、原稿不修改、缺画板拒绝');
} finally { fs.rmSync(root,{recursive:true,force:true}); }
