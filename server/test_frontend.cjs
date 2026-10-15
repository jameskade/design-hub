// 运行：node server/test_frontend.cjs。仅测试纯前端逻辑，不访问网络或业务数据库。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "static/app.js"), "utf8");
new vm.Script(source);

// 提取真实函数声明，避免在 Node 中模拟整套浏览器或复制实现。
function declaration(name, code = source) {
  const start = code.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `找不到 ${name}`);
  const end = code.slice(start + 1).search(/\n(?:async )?function /);
  return code.slice(start, end < 0 ? undefined : start + 1 + end);
}
const context = vm.createContext({ state: { version: { assets: [] } }, URLSearchParams });
// 使用真实渲染函数检查四列契约和复制完整值，不读取真实 Key。
async function verifyKeyList() {
  const token = 'dhk_TEST_ONLY_' + 'x'.repeat(64);
  const elements = new Map(); let copyHandler; let copied;
  const ctx = vm.createContext({
    api: async () => ({api_keys:[{id:'test',name:'测试别名',token,created_at:'2026-10-10T00:00:00Z'}]}),
    $: id => { if (!elements.has(id)) elements.set(id,{innerHTML:'',addEventListener(){},showModal(){}}); return elements.get(id); },
    $$: selector => selector === '[data-copy-api-key]' ? [{dataset:{copyApiKey:'test'},addEventListener:(_,fn)=>{copyHandler=fn;}}] : [],
    formatDate: () => '2026/10/10', run: fn => fn(), copyText: async text => {copied=text;}, toast() {},
  });
  vm.runInContext(declaration('escapeHtml'),ctx);
  vm.runInContext('async '+declaration('openApiKeys'),ctx);
  await vm.runInContext('openApiKeys()',ctx);
  const html=elements.get('#management-content').innerHTML;
  assert.deepEqual([...html.matchAll(/<th>(.*?)<\/th>/g)].map(m=>m[1]),['别名','完整 Key','创建时间','操作']);
  assert(!html.includes('保存说明') && !html.includes('api-key-purpose'));
  assert(html.includes('>复制</button>') && html.includes('>删除</button>'));
  await copyHandler(); assert.equal(copied,token);
  console.log('PASS: Key列表四列、复制完整值、仅复制和删除操作');
}
verifyKeyList().catch(error=>{console.error(error);process.exitCode=1;});
async function verifyKeyAliasDialog() {
  for (const [values, key] of [[null,null],[{name:'   '},null],[{name:'办公室'},null],[{name:'家用'}, {id:'existing',name:'旧名称',purpose:'保留已有用途'}]]) {
    let resolveDialog, prompt, reloads=0; const calls=[];
    const ctx=vm.createContext({
      $:()=>({close(){}}),
      promptDialog:(...args)=>{prompt=args;return new Promise(resolve=>{resolveDialog=resolve;});},
      api:async (...args)=>{calls.push(args);},
      openApiKeys:async ()=>{reloads++;},toast(){},key,
    });
    vm.runInContext('async '+declaration('editApiKeyAlias'),ctx);
    const pending=vm.runInContext('editApiKeyAlias(key)',ctx);
    assert.equal(calls.length,0,'确认前不能生成Key');
    assert.equal(prompt[1][0].required,undefined,'别名可选');
    assert.equal(prompt[2],key?'保存':'继续');
    resolveDialog(values); await pending;
    assert.equal(reloads,1);
    if (!values) assert.equal(calls.length,0,'取消不能创建Key');
    else {
      assert.equal(calls.length,1);
      assert.equal(calls[0][1].method,key?'PATCH':'POST');
      assert.equal(calls[0][1].body.name,values.name.trim() || 'AI 只读访问');
      if (key) assert.equal(calls[0][1].body.purpose,key.purpose);
    }
  }
  console.log('PASS: 创建前弹窗、别名可选、继续后创建、取消不创建、现有别名编辑');
}
verifyKeyAliasDialog().catch(error=>{console.error(error);process.exitCode=1;});
for (const name of ["layerId", "layerChildren", "hasVisibleText", "isAtomicLayer", "canSelectLayer", "isSelectableLayer", "flattenLayers", "measurementGaps", "overlapCenter", "layerAtPoint", "assetsForLayer", "escapeHtml", "valuePresent", "displayNumber", "displayPercent", "swatch", "colorValue", "fillCard", "promptStyle", "assetFilename", "icon", "textRow", "colorDetails", "fontWeightLabel", "alignmentLabel", "textOptionLabel", "renderTextSection"]) {
  vm.runInContext(declaration(name), context);
}
const evaluate = (expression) => vm.runInContext(expression, context);
async function verifyCachedImageLoading() {
  class CachedImage {
    constructor() { this.complete = false; this.naturalWidth = 0; }
    set src(value) { this.url = value; this.complete = true; this.naturalWidth = 780; }
  }
  const ctx = vm.createContext({ Image: CachedImage, Error, Promise });
  vm.runInContext(declaration('loadImage'), ctx);
  const image = await vm.runInContext('loadImage("/cached-preview.png")', ctx);
  assert.equal(image.naturalWidth, 780, '已缓存图片不能等待永不结束的 decode()');
  console.log('PASS: 已缓存旧预览可立即完成加载');
}
verifyCachedImageLoading().catch(error=>{console.error(error);process.exitCode=1;});
{
  vm.runInContext(declaration('layerAncestors'), context);
  vm.runInContext(declaration('selectionTarget'), context);
  const outer={key:'outer',layer:{type:'Group'},width:100,height:100};
  const group={key:'bell-group',parentKey:'outer',layer:{type:'Group'},width:33,height:34};
  const text={key:'badge',parentKey:'bell-group',layer:{type:'Text'},width:10,height:10};
  const unrelated={key:'other',layer:{type:'Shape'},width:10,height:10};
  context.state.layerRects=new Map([outer,group,text,unrelated].map(item=>[item.key,item]));
  Object.assign(context,{parentHit:text,parentCurrent:null});
  assert.equal(evaluate('selectionTarget(parentHit,parentCurrent,false).key'),'badge','普通点击仍选角标文字');
  assert.equal(evaluate('selectionTarget(parentHit,parentCurrent,true).key'),'bell-group','首次Alt点击直接选择父编组');
  context.parentCurrent=group;
  assert.equal(evaluate('selectionTarget(parentHit,parentCurrent,true).key'),'outer','同一位置重复Alt逐级向上');
  context.parentCurrent=outer;
  assert.equal(evaluate('selectionTarget(parentHit,parentCurrent,true).key'),'outer','到顶不跳到无关图层');
  assert.equal(evaluate('selectionTarget(parentHit,parentCurrent,false).key'),'badge','普通点击可重新选回子层');
  context.parentCurrent=unrelated;
  assert.equal(evaluate('selectionTarget(parentHit,parentCurrent,true).key'),'bell-group','切换命中位置不沿旧选区找父层');
  group.hidden=true;
  assert.equal(evaluate('selectionTarget(parentHit,null,true).key'),'outer','祖先过滤不可绕过隐藏限制');
  assert.equal(evaluate('selectionTarget(null,parentCurrent,true)'),null,'空白不推断组合');
  context.parentHit=unrelated;
  assert.equal(evaluate('selectionTarget(parentHit,null,true).key'),'other','无父层不拼接邻居');
}
{
  const parent = {key:'button',layer:{name:'按钮<分组>',type:'Group'},width:44,height:44,x:0,y:0};
  const child = {key:'plus',parentKey:'button',layer:{name:'加号',type:'Shape'},width:20,height:20,x:12,y:12};
  const ui = {classList:{remove(){},toggle(){}},append(){},focus(){},remove(){},setAttribute(){}};
  const ctx = vm.createContext({state:{layerRects:new Map([['button',parent],['plus',child]])},
    $:()=>ui,$$:()=>[],clearMeasurements(){},renderProperties(){},
    document:{createElement:()=>({style:{},setAttribute(){}})},child});
  for (const name of ['hasVisibleText','layerChildren','isAtomicLayer','canSelectLayer','isSelectableLayer','selectLayer','layerAncestors','layerHierarchy','escapeHtml','exportScopes']) vm.runInContext(declaration(name),ctx);
  vm.runInContext('selectLayer("plus"); selectLayer("button")',ctx);
  assert.equal(ctx.state.selectedLayer.key,'plus','透明父层不参与普通点击');
  assert.equal(vm.runInContext('layerAncestors(child)[0].key',ctx),'button');
  assert(vm.runInContext('layerHierarchy(child)',ctx).includes('按钮&lt;分组&gt;'));
  assert(vm.runInContext('layerHierarchy(child)',ctx).includes('选择图层'));
  assert.equal(vm.runInContext('layerHierarchy(state.layerRects.get("button"))',ctx),'','无可选父层时隐藏层级入口');
  vm.runInContext('selectLayer("button",true)',ctx);
  assert.equal(ctx.state.selectedLayer.key,'button','显式父层选择允许透明布局容器');
  assert.equal(vm.runInContext('exportScopes(state.selectedLayer)[0].item.key',ctx),'button','选区和导出必须同时切换');
  parent.hidden=true; vm.runInContext('selectLayer("plus"); selectLayer("button",true)',ctx);
  assert.equal(ctx.state.selectedLayer.key,'plus','显式选择仍不能绕过隐藏过滤');
}
{
  vm.runInContext(declaration('exportScopes'), context);
  const outer = {key:'outer',layer:{name:'整体切图',type:'Group',exportFormats:[{fileFormat:'png'}]}};
  const inner = {key:'inner',parentKey:'outer',layer:{name:'内层切图',type:'Group',exportFormats:[{fileFormat:'png'}]}};
  const label = {key:'label',parentKey:'inner',layer:{name:'文字',type:'Text'}};
  context.state.layerRects = new Map([['outer',outer],['inner',inner],['label',label]]);
  context.scopeItem = label;
  assert.equal(evaluate('exportScopes(scopeItem).length'),1);
  assert.equal(evaluate('exportScopes(scopeItem)[0].item.key'),'label','选中子层不能自动导出父层');
  context.scopeItem = outer;
  assert.equal(evaluate('exportScopes(scopeItem)[0].item.key'),'outer');
  outer.layer.exportFormats = []; inner.layer.exportFormats = [];
  context.scopeItem = label;
  assert.equal(evaluate('exportScopes(scopeItem).length'),1,'导出面板不能另行切换选区');
  assert.equal(evaluate('exportScopes(scopeItem)[0].members[0].key'),'label');
  context.state.version.assets = [{layer_id:'outer',kind:'slice',format:'png'}];
  label.layer.id = 'label'; outer.layer.id = 'outer';
  assert.equal(evaluate('assetsForLayer(exportScopes(scopeItem)[0].item.layer).length'),0,'子层缺少资源时不能回退父资源');
  context.scopeItem = outer;
  assert.equal(evaluate('assetsForLayer(exportScopes(scopeItem)[0].item.layer).length'),1,'明确选中父层才导出父资源');
}
const assertGeometry = (expression, expected) => assert.equal(JSON.stringify(evaluate(expression)), JSON.stringify(expected));
const first = "AF235EED-38E9-46BE-9776-F135B2E3C456";
const second = "DCE524C4-8000-4CC2-BA39-31D85C0AB266";
context.first = first;
context.second = second;
assert.equal(evaluate("layerId({var:first})"), first);
assert.equal(evaluate("layerId({id:first,objectID:second,var:second})"), first);
evaluate('state.version.assets = [{id:"a", layer_id:first, name:"矩形", kind:"slice"}, {id:"b", layer_id:second, name:"矩形", kind:"slice"}, {id:"c", layer_id:first, name:"矩形", kind:"slice-no-shadow"}]');
assert.equal(evaluate('assetsForLayer({var:first,name:"矩形"}).map(a=>a.id).join()'), "a");
assert.equal(evaluate('assetsForLayer({var:first,name:"矩形"},"slice-no-shadow").map(a=>a.id).join()'), "c");
assert.equal(evaluate('assetsForLayer({var:"missing",name:"矩形"}).length'), 0, "真实 ID 不匹配时不能退回同名资源");
assert.equal(evaluate('assetsForLayer({name:"矩形"}).length'), 2, "保留无 ID 历史数据的兼容路径");
assert.equal(evaluate('flattenLayers([{var:first,frame:{x:10,y:20,width:100,height:100},layers:[{var:second,frame:{x:2,y:3,width:5,height:6}}]}])[1].parentKey'), first);
assert.equal(evaluate('flattenLayers([{var:first,frame:{x:10,y:20},layers:[{var:second,frame:{x:2,y:3}}]}])[1].x'), 12);
assertGeometry('measurementGaps({x:0,y:0,width:100,height:100},{x:120,y:20,width:20,height:20})', [{axis:"x",from:100,to:120,at:30},{axis:"y",from:0,to:20,at:110},{axis:"y",from:40,to:100,at:110}]);
assertGeometry('measurementGaps({x:0,y:0,width:100,height:100},{x:20,y:20,width:20,height:20})', [{axis:"x",from:0,to:20,at:30},{axis:"x",from:40,to:100,at:30},{axis:"y",from:0,to:20,at:30},{axis:"y",from:40,to:100,at:30}]);
assertGeometry('measurementGaps({x:0,y:0,width:100,height:100},{x:20,y:120,width:20,height:20})', [{axis:"x",from:0,to:20,at:110},{axis:"x",from:40,to:100,at:110},{axis:"y",from:100,to:120,at:30}]);
assertGeometry('measurementGaps({x:20,y:20,width:20,height:20},{x:0,y:0,width:100,height:100})', [{axis:"x",from:0,to:20,at:30},{axis:"x",from:40,to:100,at:30},{axis:"y",from:0,to:20,at:30},{axis:"y",from:40,to:100,at:30}]);
assertGeometry('measurementGaps({x:0,y:0,width:100,height:100},{x:40,y:50,width:100,height:100})', [{axis:"x",from:0,to:40,at:75},{axis:"x",from:100,to:140,at:75},{axis:"y",from:0,to:50,at:70},{axis:"y",from:100,to:150,at:70}]);
assertGeometry('measurementGaps({x:0,y:0,width:20,height:20},{x:30,y:40,width:10,height:10})', [{axis:"x",from:20,to:30,at:30},{axis:"y",from:20,to:40,at:25}]);
assertGeometry('measurementGaps({x:0,y:0,width:20,height:20},{x:20,y:0,width:20,height:20})', []);
assertGeometry('measurementGaps({x:0,y:0,width:20,height:20},{x:20.25,y:0,width:20,height:20})', [{axis:"x",from:20,to:20.25,at:10}]);
context.hitLayers = [
  {key:"parent",x:0,y:0,width:100,height:100,depth:0,layer:{}},
  {key:"child",parentKey:"parent",x:10,y:10,width:20,height:20,depth:1,layer:{}},
  {key:"same-frame",x:10,y:10,width:20,height:20,depth:2,layer:{}},
  {key:"hidden",x:11,y:11,width:2,height:2,depth:3,hidden:true,layer:{}},
  {key:"line",x:60,y:30,width:1,height:30,depth:1,layer:{}}
];
assert.equal(evaluate('layerAtPoint(hitLayers,12,12).key'), "same-frame", "同面积优先真实深层，隐藏节点不截获鼠标");
assert.equal(evaluate('layerAtPoint(hitLayers,12,12,hitLayers[1]).key'), "parent", "同框装饰层不应挡住父层间距");
assert.equal(evaluate('layerAtPoint(hitLayers,60.5,40).key'), "line", "1pt 细线也能命中");
assert.equal(evaluate('flattenLayers([{id:"p",hidden:true,layers:[{id:"c"}]}])[1].hidden'), true, "隐藏父容器的子层不能参与鼠标命中");
context.boundaryLayers = [
  {id:'background-group',type:'Group',frame:{x:32,y:102,width:322,height:177},layers:[{id:'star',type:'Image',frame:{x:49,y:60,width:20,height:20}}]},
  {id:'icon',type:'Group',exportFormats:[{fileFormat:'png'}],frame:{x:26,y:215,width:24,height:24},layers:[{id:'path',type:'ShapePath',frame:{x:3,y:4,width:6,height:5}}]},
  {id:'boolean',type:'Shape',frame:{x:100,y:215,width:24,height:24},layers:[{id:'internal',type:'ShapePath',frame:{x:0,y:0,width:2,height:3}}]},
  {id:'empty',type:'Group',frame:{x:200,y:100,width:50,height:50}},
  {id:'white',type:'Group',style:{fills:[{enabled:true,color:'#ffffffff'}]},frame:{x:260,y:100,width:50,height:50}}
];
assert.equal(evaluate('flattenLayers(boundaryLayers).map(item=>item.key).join()'),'background-group,star,icon,boolean,empty,white');
assert.equal(evaluate('layerAtPoint(flattenLayers(boundaryLayers),40,120)'),null,'透明容器不抢占空白位置');
assert.equal(evaluate('layerAtPoint(flattenLayers(boundaryLayers),82,163).key'),'star','容器内真实图片仍可选');
assert.equal(evaluate('layerAtPoint(flattenLayers(boundaryLayers),30,220).key'),'icon','路径位置只选中整体图标');
assert.equal(evaluate('layerAtPoint(flattenLayers(boundaryLayers),101,216).key'),'boolean');
assert.equal(evaluate('layerAtPoint(flattenLayers(boundaryLayers),210,110)'),null);
assert.equal(evaluate('layerAtPoint(flattenLayers(boundaryLayers),270,110).key'),'white','真实白色填充不可误删');
assert.equal(evaluate('flattenLayers(boundaryLayers).filter(isSelectableLayer).map(item=>item.key).join()'),'star,icon,boolean,white','键盘热点与鼠标使用同一规则');
context.textCard = {id:'card',type:'Group',exportFormats:[{fileFormat:'png'}],frame:{x:50,y:90,width:258,height:177},layers:[
  {id:'copy',type:'Text',frame:{x:0,y:68,width:258,height:44}},
  {id:'button',type:'Group',exportFormats:[{fileFormat:'png'}],frame:{x:0,y:120,width:258,height:50},layers:[{id:'log',type:'Text',frame:{x:100,y:10,width:38,height:27}}]},
  {id:'nested-icon',type:'Group',exportFormats:[{fileFormat:'png'}],frame:{x:110,y:0,width:24,height:24},layers:[{id:'icon-path',type:'ShapePath',frame:{x:0,y:0,width:5,height:5}}]}
]};
assert.equal(evaluate('layerAtPoint(flattenLayers([textCard]),60,165).key'),'copy','卡片设置切图仍能选说明文字');
assert.equal(evaluate('layerAtPoint(flattenLayers([textCard]),155,225).key'),'log','嵌套按钮文字仍可选择');
assert.equal(evaluate('layerAtPoint(flattenLayers([textCard]),162,92).key'),'nested-icon','卡片内图标路径仍只选整体');
assert.equal(evaluate('flattenLayers([textCard]).some(item=>item.key === "icon-path")'),false);
assert.equal(evaluate('isAtomicLayer({type:"Group",exportFormats:[{}],layers:[{type:"Text",hidden:true}]})'),true);
assert.equal(evaluate('layerAtPoint([...Array.from({length:400},(_,i)=>({key:String(i),x:i,y:0,width:1,height:1,depth:0,layer:{}}))],399.5,.5).key'), "399", "命中不受 DOM 按钮数量限制");
assert.equal(evaluate('fillCard({fillType:"Color",color:"#000000",gradient:{type:"Linear",stops:[]}},0).includes("渐变类型")'), false);
assert.equal(evaluate('fillCard({fillType:"Gradient",gradient:{type:"Linear",stops:[]}},0).includes("渐变类型")'), true);
assert.equal(evaluate('promptStyle({style:{fills:[{fillType:"Color",color:"#000000",gradient:{type:"Linear"}}]}})'), "填充 #000000");
assert.equal(evaluate('assetFilename("图层/按钮", "png", 2, "ios")'), "图层-按钮@2x.png");
context.unsafeText = '<script>"&';
assert.equal(evaluate('escapeHtml(unsafeText)'), "&lt;script&gt;&quot;&amp;");
const renderedText = evaluate('renderTextSection({content:unsafeText,fontSize:16},1)');
assert.ok(!renderedText.includes('<button') && renderedText.includes('data-copy-value') && renderedText.includes('&lt;script&gt;&quot;&amp;'));
assert.ok(renderedText.indexOf('内容') < renderedText.indexOf('字体名称'), "文本内容与双击复制值必须保留");
console.log("PASS: UUID 与资源隔离、父子/同级/重叠/斜向/小数间距、隐藏和细线命中、复制转义、纯色与导出文件名");
const connectSource = fs.readFileSync(path.join(__dirname, "static/connect.js"), "utf8");
new vm.Script(connectSource);
vm.runInContext(declaration("buildMcpConfig", connectSource), context);
vm.runInContext(declaration("buildNpxMcpConfig", connectSource), context);
context.URL = URL;
const npmConfig = JSON.parse(evaluate('buildNpxMcpConfig("json", "npx", "http://192.168.1.100:8765", "/downloads/design-hub-mcp-1.0.2.tgz")')).mcpServers['design-hub'];
assert.equal(npmConfig.args[1], '--package=http://192.168.1.100:8765/downloads/design-hub-mcp-1.0.2.tgz');
assert.equal(npmConfig.args[3], '--base-url=http://192.168.1.100:8765');
assert(npmConfig.env.DESIGN_HUB_API_KEY);
assert.throws(() => evaluate('buildNpxMcpConfig("json", "npx", "http://user:secret@localhost", "/downloads/design-hub-mcp-1.0.2.tgz")'));
context.configPath = '/Users/example/Design Files/a "quoted" file.py';
const config = evaluate('buildMcpConfig("codex", "python3", configPath)');
assert.ok(config.startsWith('[mcp_servers.design-hub]'));
assert.equal(JSON.parse(config.split('args = ')[1])[0], context.configPath);
assert.ok(!config.includes('api_key') && !config.includes('base_url'));
context.configPath = 'C:\\Users\\Example User\\Downloads\\design_hub_mcp.py';
assert.equal(JSON.parse(evaluate('buildMcpConfig("json", "python", configPath)')).mcpServers['design-hub'].args[0], context.configPath);
for (const invalid of ['', '~/Downloads/design_hub_mcp.py', './design_hub_mcp.py', 'https://example.test/mcp', '/tmp/example.js', '/tmp/bad\nname.py']) {
  context.configPath = invalid;
  assert.throws(() => evaluate('buildMcpConfig("codex", "python3", configPath)'));
}
console.log('PASS: MCP TOML/JSON、路径空格与引号、Windows 路径、无凭据配置、非法路径拒绝');
