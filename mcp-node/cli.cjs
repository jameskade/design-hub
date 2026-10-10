#!/usr/bin/env node
'use strict';
const readline = require('node:readline');
const {version} = require('./package.json');
const options = process.argv.slice(2);
let configuredURL = process.env.DESIGN_HUB_BASE_URL || '';
for (let i = 0; i < options.length; i++) {
  if (options[i] === '--help') {
    process.stdout.write('design-hub-mcp --base-url=http://server:8765\n认证：DESIGN_HUB_API_KEY 环境变量，或工具参数 api_key。需要 Node.js 18+。\n');
    process.exit(0);
  }
  if (options[i] === '--version') { process.stdout.write(version + '\n'); process.exit(0); }
  if (options[i].startsWith('--base-url=')) configuredURL = options[i].slice(11);
  else if (options[i] === '--base-url' && options[i + 1]) configuredURL = options[++i];
  else { process.stderr.write('无效参数，请使用 --help\n'); process.exit(1); }
}
function origin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('服务地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('服务地址必须为 HTTP(S)，且不能携带凭据');
  return url.origin;
}
try { if (configuredURL) configuredURL = origin(configuredURL); }
catch (error) { process.stderr.write(error.message + '\n'); process.exit(1); }
const definitions = [
  ['design_hub_list_projects', '列出个人 Key 有权查看的项目', null],
  ['design_hub_get_artboard_context', '读取画板图层、文字、布局和资源', 'artboard'],
  ['design_hub_get_asset', '读取画板资源', 'asset_id'],
];
const tools = definitions.map(([name, description, field]) => ({name, description, inputSchema: {
  type:'object', properties:{base_url:{type:'string',description:'可省略，默认使用启动参数'}, api_key:{type:'string',description:'可省略，默认使用 DESIGN_HUB_API_KEY'}, ...(field ? {[field]:{type:'string'}} : {})},
  required:field ? [field] : [], additionalProperties:false,
}}));
async function call(name, args) {
  if (!definitions.some(d => d[0] === name)) throw new Error('未知工具');
  const base = origin(args.base_url || configuredURL);
  // 环境变量中的个人 Key 不得因模型改写 base_url 而发送到另一个服务。
  if (!args.api_key && process.env.DESIGN_HUB_API_KEY && base !== configuredURL) throw new Error('使用环境变量 Key 时不能切换服务地址');
  const key = args.api_key || process.env.DESIGN_HUB_API_KEY || '';
  if (typeof key !== 'string' || !key.startsWith('dhk_')) throw new Error('请设置个人 DESIGN_HUB_API_KEY 或 api_key 参数');
  let path = '/api/projects';
  if (name !== 'design_hub_list_projects') {
    const value = String(args[name === 'design_hub_get_asset' ? 'asset_id' : 'artboard'] || '');
    const match = name === 'design_hub_get_artboard_context' && value.match(/\/artboards\/([0-9a-fA-F-]+)/);
    const id = match ? match[1] : value;
    if (!/^[0-9A-Za-z-]+$/.test(id)) throw new Error('画板或资源 ID 无效');
    path = name === 'design_hub_get_asset' ? `/api/assets/${id}/download` : `/api/artboards/${id}/ai-context`;
  }
  let response;
  try {
    response = await fetch(base + path, {headers:{Authorization:`Bearer ${key}`}, redirect:'error', signal:AbortSignal.timeout(30000)});
  } catch { throw new Error('连接 Design Hub 失败或超时，请检查服务地址和网络'); }
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Design Hub HTTP ${response.status}，请检查个人 Key 和项目权限`); }
  const buffers = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 25 * 1024 * 1024) throw new Error('响应超过 25MB');
    buffers.push(chunk);
  }
  const data = Buffer.concat(buffers);
  if (name === 'design_hub_get_asset') {
    const mime = (response.headers.get('content-type') || 'application/octet-stream').split(';')[0];
    if (['image/png','image/jpeg','image/webp','image/gif'].includes(mime)) return [{type:'image',data:data.toString('base64'),mimeType:mime}];
    if (mime === 'image/svg+xml') return [{type:'text',text:data.toString('utf8')}];
    return [{type:'resource',resource:{uri:base+path,mimeType:mime,blob:data.toString('base64')}}];
  }
  return [{type:'text',text:JSON.stringify(JSON.parse(data.toString('utf8')))}];
}
async function handle(message) {
  if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return {jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid Request'}};
  if (message.id === undefined) return null;
  const reply = {jsonrpc:'2.0',id:message.id};
  switch(message.method) {
    case 'initialize': return {...reply,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'design-hub',version}}};
    case 'ping': return {...reply,result:{}};
    case 'tools/list': return {...reply,result:{tools}};
    case 'tools/call':
      try { return {...reply,result:{content:await call(message.params?.name,message.params?.arguments || {}),isError:false}}; }
      catch(error) { return {...reply,result:{content:[{type:'text',text:error.message}],isError:true}}; }
    default: return {...reply,error:{code:-32601,message:'Method not found'}};
  }
}
// 串行消费 stdio，保证 EOF 前待处理请求完成；stdout 仅输出协议数据。
(async () => {
  for await (const line of readline.createInterface({input:process.stdin,crlfDelay:Infinity})) {
    let message;
    try { message = JSON.parse(line); }
    catch { process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}})+'\n'); continue; }
    const result = await handle(message);
    if (result) process.stdout.write(JSON.stringify(result)+'\n');
  }
})().catch(() => { process.stderr.write('MCP 输入流异常\n'); process.exitCode = 1; });
