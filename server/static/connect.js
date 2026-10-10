let mcpNpmDownload = null;
function connectSectionFromPath() {
  const match = location.pathname.match(/^\/connect(?:\/(sketch|mcp|guide))?\/?$/);
  return match ? match[1] || "sketch" : null;
}

function showConnectSection(section, push = false) {
  if (!["sketch", "mcp", "guide"].includes(section)) return;
  const panel = document.querySelector(`#connect-${section}`); const changed = panel.classList.contains("hidden");
  document.querySelectorAll(".connect-panel").forEach((el) => el.classList.toggle("hidden", el !== panel));
  document.querySelectorAll("[data-connect-tab]").forEach((el) => { const active = el.dataset.connectTab === section; el.classList.toggle("active", active); if (active) el.setAttribute("aria-current", "page"); else el.removeAttribute("aria-current"); });
  document.title = `${({sketch:"Sketch 插件",mcp:"MCP 接入",guide:"使用指南"})[section]} · Design Hub`;
  if (push) { setRoute(`/connect/${section}`); document.querySelector("#connect-view").scrollTop = 0; document.querySelector(`#${section}-heading`).focus({preventScroll:true}); }
  if (changed) reveal(panel);
}

async function loadConnectDownloads() {
  const links = [...document.querySelectorAll("[data-integration-download]")];
  links.forEach((a) => { a.setAttribute("aria-disabled", "true"); a.tabIndex = -1; });
  document.querySelector("#connect-download-error").classList.add("hidden");
  try {
    const info = await api("/api/integrations");
    if (!info.sketch?.version || info.mcp?.transport !== "stdio") throw new Error("接入信息无效");
    mcpNpmDownload = info.mcp.npm_download_url || null;
    renderMcpConfig();
    document.querySelector("#sketch-version").textContent = `v${info.sketch.version}`;
    document.querySelector("#sketch-compatible").textContent = info.sketch.compatible_version ? `macOS · Sketch ${info.sketch.compatible_version}+` : "macOS + Sketch";
    links.forEach((a) => { a.removeAttribute("aria-disabled"); a.tabIndex = 0; });
  } catch {
    mcpNpmDownload = null;
    renderMcpConfig();
    document.querySelector("#sketch-version").textContent = "版本暂不可用";
    document.querySelector("#connect-download-error").classList.remove("hidden");
  }
}

async function initializeConnect() {
  showOnly("#connect-view"); showConnectSection(connectSectionFromPath() || "sketch");
  document.querySelector(".skip-link").href = "#connect-view";
  const button = document.querySelector("#api-keys-button"); const login = document.querySelector("#connect-login"); const status = document.querySelector("#connect-key-status");
  button.disabled = true; login.classList.add("hidden"); status.textContent = "正在检查登录状态…";
  await Promise.all([loadConnectDownloads(), (async () => {
    try {
      const result = await api("/api/me"); state.user = result.user; state.csrf = result.csrf_token;
      document.querySelector("#connect-home").textContent = "返回工作台";
      const active = ["developer", "designer", "admin"].includes(state.user.role);
      button.disabled = !active; status.textContent = active ? `已登录为 ${state.user.display_name}。新建 Key 可在本人管理页再次查看、复制或删除；旧版 Key 原文不可恢复。` : "账号尚未获准访问项目，请联系管理员分配身份后再创建 Key。";
    } catch (error) {
      state.user = null; state.csrf = "";
      login.classList.remove("hidden"); status.textContent = error.status === 401 ? "登录后创建个人只读 Key。下载和配置说明无需登录。" : "暂时无法核对账号状态。请检查连接，或重新登录工作台。";
      document.querySelector("#connect-home").textContent = "登录工作台";
    }
  })()]);
}

function buildMcpConfig(client, command, scriptPath) {
  const python = command.trim(); const path = scriptPath.trim();
  if (!python || /[\x00-\x1f\x7f]/.test(python)) throw new Error("填写有效的 Python 命令或解释器路径。");
  if (!/^(\/|[a-z]:[\\/]|\\\\[^\\]+\\)/i.test(path) || /[\x00-\x1f\x7f]/.test(path) || !/\.py$/i.test(path)) throw new Error("请填写 .py 脚本的绝对路径，不使用相对路径或 ~ 缩写。");
  // JSON 字符串转义同样适用于此处 TOML 基本字符串，保留空格、引号和 Windows 反斜线。
  if (client === "codex") return `[mcp_servers.design-hub]\ncommand = ${JSON.stringify(python)}\nargs = [${JSON.stringify(path)}]\n`;
  if (client === "json") return JSON.stringify({mcpServers:{"design-hub":{command:python,args:[path]}}}, null, 2);
  throw new Error("请选择支持的客户端配置格式。");
}

function renderMcpConfig() {
  const client = document.querySelector("#mcp-client").value; const path = document.querySelector("#mcp-script-path"); const output = document.querySelector("#mcp-config-output"); const copy = document.querySelector("#copy-mcp-config"); const error = document.querySelector("#mcp-config-error");
  document.querySelector("#mcp-config-filename").textContent = client === "codex" ? "~/.codex/config.toml" : "mcpServers 配置片段";
  document.querySelector("#mcp-official-docs").classList.toggle("hidden", client !== "codex");
  document.querySelector("#mcp-client-help").textContent = client === "codex" ? "合并到已有 config.toml，保留其他服务条目。保存后重新加载 MCP，或重新打开客户端；可用 codex mcp list 查看配置。" : "适用于接受 mcpServers 的 JSON 配置文件。合并到已有对象，不要覆盖其他服务；配置位置与重载方式请以客户端说明为准。";
  try {
    const npxMode = document.querySelector("#mcp-mode").value === "npx";
    document.querySelectorAll("[data-python-field]").forEach(el => el.classList.toggle("hidden", npxMode));
    document.querySelectorAll("[data-npx-field]").forEach(el => el.classList.toggle("hidden", !npxMode));
    output.textContent = npxMode ? buildNpxMcpConfig(client, document.querySelector("#mcp-npx").value, document.querySelector("#mcp-server").value, mcpNpmDownload) : buildMcpConfig(client, document.querySelector("#mcp-python").value, path.value);
    copy.disabled = false; error.textContent = npxMode ? "请在自己的客户端替换个人 Key 占位符。不要分享含真实 Key 的配置。" : "配置不包含 API Key；服务地址和 Key 在工具调用时提供。"; path.removeAttribute("aria-invalid");
  } catch (failure) {
    copy.disabled = true; output.textContent = "请检查上方配置或等待安装信息加载。"; error.textContent = failure.message; if (path.value) path.setAttribute("aria-invalid", "true"); else path.removeAttribute("aria-invalid");
  }
}

function buildNpxMcpConfig(client, command, baseURL, packagePath) {
  if (!packagePath || !/^\/downloads\/design-hub-mcp-\d+\.\d+\.\d+\.tgz$/.test(packagePath)) throw new Error("正在获取安装包版本，请稍后或重试加载。");
  const url = new URL(baseURL);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("请输入不含凭据或查询参数的 HTTP(S) 服务地址。");
  command = command.trim();
  if (!command || /[\x00-\x1f\x7f]/.test(command)) throw new Error("填写 npx 命令或绝对路径。");
  const args = ["-y", `--package=${url.origin}${packagePath}`, "design-hub-mcp", `--base-url=${url.origin}`];
  const env = {DESIGN_HUB_API_KEY: "在客户端替换为个人只读Key"};
  if (client === "json") return JSON.stringify({mcpServers:{"design-hub":{command,args,env}}}, null, 2);
  if (client === "codex") return `[mcp_servers.design-hub]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\n\n[mcp_servers.design-hub.env]\nDESIGN_HUB_API_KEY = ${JSON.stringify(env.DESIGN_HUB_API_KEY)}\n`;
  throw new Error("请选择支持的客户端配置格式。");
}

function setupConnect() {
  document.querySelector("#mcp-server").value = location.origin;
  document.querySelectorAll("[data-service-origin]").forEach((el) => { el.textContent = location.origin; });
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  document.querySelector("#connect-loopback-note").classList.toggle("hidden", !local);
  document.querySelectorAll("[data-copy-origin]").forEach((button) => button.addEventListener("click", () => run(async () => { await copyText(location.origin); toast("服务地址已复制"); })));
  document.querySelectorAll("[data-connect-tab], [data-connect-link]").forEach((link) => link.addEventListener("click", (event) => {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); showConnectSection(new URL(link.href).pathname.split("/").pop(), true);
  }));
  document.querySelectorAll("[data-integration-download]").forEach((link) => link.addEventListener("click", (event) => { if (link.getAttribute("aria-disabled") === "true") event.preventDefault(); }));
  document.querySelector("#retry-integrations").addEventListener("click", () => run(initializeConnect));
  ["#mcp-client", "#mcp-mode", "#mcp-npx", "#mcp-server", "#mcp-python", "#mcp-script-path"].forEach((selector) => document.querySelector(selector).addEventListener("input", renderMcpConfig));
  document.querySelector("#copy-mcp-config").addEventListener("click", () => run(async () => { if (document.querySelector("#copy-mcp-config").disabled) return; await copyText(document.querySelector("#mcp-config-output").textContent); toast("配置已复制"); }));
  document.querySelector("#copy-mcp-check").addEventListener("click", () => run(async () => {
    const connection = document.querySelector("#mcp-mode").value === "npx" ? "使用启动配置中的服务地址和 DESIGN_HUB_API_KEY，无需重复传凭据。" : `base_url 使用 ${location.origin}，api_key 使用我另行提供的个人只读 Key。`;
    await copyText(`请实际调用 Design Hub MCP 验证接入：\n1. 调用 design_hub_list_projects，${connection}\n2. 让我提供一个有权限的设计稿完整链接，用 design_hub_get_artboard_context 读取。\n3. 从返回资源中选一个 PNG，调用 design_hub_get_asset 确认读取真实图片。\n请报告真实调用结果，不要只根据配置推断成功，不要复述完整 Key。`); toast("验证指引已复制");
  }));
  renderMcpConfig();
}
