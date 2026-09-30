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
for (const name of ["layerId", "layerChildren", "flattenLayers", "measurementGaps", "overlapCenter", "layerAtPoint", "assetsForLayer", "escapeHtml", "valuePresent", "displayNumber", "displayPercent", "swatch", "colorValue", "fillCard", "promptStyle", "assetFilename", "icon", "textRow", "colorDetails", "fontWeightLabel", "alignmentLabel", "textOptionLabel", "renderTextSection"]) {
  vm.runInContext(declaration(name), context);
}
const evaluate = (expression) => vm.runInContext(expression, context);
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
