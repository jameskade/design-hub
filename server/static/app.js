const state = {
  user: null, csrf: sessionStorage.getItem("designHubCsrf") || "", projects: [], project: null,
  folders: [], artboards: [], folderId: null, artboard: null, version: null,
  selectedLayer: null, exportScopeKey: null, exportIncludeShadows: true, layerRects: new Map(), zoom: 1, stageZoom: 0.72,
  stagePan: { x: 320, y: 150 }, viewerPan: { x: 80, y: 70 }, stageSelectedId: null,
  expandedFolders: new Set(), stageSelectedFolderId: null, stageSidebarCollapsed: false, viewerSidebarCollapsed: false,
  navigationEpoch: 0, versionEpoch: 0, spacePressed: false, interactionsReady: false,
  projectPreviews: new Map(), spotlightProjectId: null,
};
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
function icon(name, size = 18) {
  const paths = {
    "arrow-left": '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
    "chevron-left": '<path d="m15 18-6-6 6-6"/>',
    "chevron-right": '<path d="m9 18 6-6-6-6"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    fit: '<path d="M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5"/>',
    sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
    folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m4 17 5-5 3.5 3.5 2.5-2.5 5 5"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    settings: '<path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h7M15 18h5"/><circle cx="16" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="13" cy="18" r="2"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8M15 8l3 3M17 6l2 2"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l2-2a5 5 0 0 0-7.07-7.07l-1.15 1.14"/><path d="M14 11a5 5 0 0 0-7.54-.54l-2 2a5 5 0 0 0 7.07 7.07l1.14-1.14"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/>',
    logout: '<path d="M10 17l5-5-5-5M15 12H3M15 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/>',
    "arrow-right": '<path d="M5 12h14m-6-6 6 6-6 6"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4 2c-1 .6-1.5 1-1.5 2M12 17h.01"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M4 15v5h16v-5"/>',
    plug: '<path d="M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-12 0V8Zm6 9v4"/>',
  };
  return `<svg class="icon-svg" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || ""}</svg>`;
}
function hydrateIcons() { $$('[data-icon]').forEach((element) => { const label = element.dataset.label; element.innerHTML = `${icon(element.dataset.icon)}${label ? `<span>${escapeHtml(label)}</span>` : ""}`; element.classList.toggle("has-icon-label", Boolean(label)); if (element.tagName === "BUTTON" && !element.hasAttribute("aria-label")) element.setAttribute("aria-label", label || element.title || element.dataset.icon); }); }

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
function reveal(element) { if (!reducedMotion.matches && element?.animate) element.animate([{ opacity: .35, transform: "translateY(7px)" }, { opacity: 1, transform: "none" }], { duration: 220, easing: "cubic-bezier(.2,.8,.2,1)" }); }
async function run(action) { try { return await action(); } catch (error) { toast(error.message || "操作未完成，请重试"); } }
let loadingTicket = 0;
function beginLoading(message) { const ticket = ++loadingTicket; $("#busy-message").textContent = message; $("#busy-status").classList.remove("hidden"); return () => { if (ticket === loadingTicket) $("#busy-status").classList.add("hidden"); }; }
function closeInspector() { $("#viewer-view").classList.add("inspector-closed"); $(".inspector-panel").inert = true; state.selectedLayer = null; clearMeasurements(); $$(".layer-hotspot.active").forEach((el) => el.classList.remove("active")); }
function openGuide() { window.open("/connect/guide", "_blank", "noopener"); }

async function api(path, options = {}) {
  const init = { credentials: "same-origin", ...options };
  init.headers = { ...(options.headers || {}) };
  if (options.body && typeof options.body !== "string") {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  if (init.method && init.method !== "GET" && state.csrf) init.headers["X-CSRF-Token"] = state.csrf;
  const response = await fetch(path, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(payload.error || `请求失败 (${response.status})`); error.status = response.status; throw error; }
  return payload;
}
function showOnly(id) { $("#boot-status").classList.add("hidden"); ["#auth-view", "#pending-view", "#app-view", "#connect-view"].forEach((s) => $(s).classList.toggle("hidden", s !== id)); reveal($(id)); }
function showWorkspace(id) { const entering = $(id).classList.contains("hidden"); ["#dashboard-view", "#stage-view", "#viewer-view"].forEach((s) => $(s).classList.toggle("hidden", s !== id)); $(".skip-link").href = id === "#viewer-view" ? "#canvas-scroll" : id === "#stage-view" ? "#stage-search" : id; if (entering) reveal($(id)); }
let toastTimer;
function toast(message) { const el = $("#toast"); el.textContent = message; el.classList.add("visible"); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("visible"), 2600); }
function roleLabel(role) { return ({ pending: "待审核", developer: "开发", designer: "设计", admin: "管理员", disabled: "已禁用", viewer: "查看", editor: "编辑", owner: "Owner" })[role] || role; }

async function initialize() {
  if (connectSectionFromPath()) return initializeConnect();
  try {
    const result = await api("/api/me");
    state.user = result.user; state.csrf = result.csrf_token; sessionStorage.setItem("designHubCsrf", state.csrf);
    if (state.user.role === "pending") return showOnly("#pending-view");
    if (state.user.role === "disabled") throw new Error("账号已被禁用");
  } catch (error) { showOnly("#auth-view"); if (error.status !== 401) $("#auth-message").textContent = "暂时无法连接设计空间，请检查服务后重新登录。"; return; }
  showOnly("#app-view"); configureShell();
  // 登录后可能再次初始化，画布监听只绑定一次，避免滚轮和拖动重复执行。
  if (!state.interactionsReady) { setupStageInteractions(); setupViewerInteractions(); state.interactionsReady = true; }
  try { await loadProjects(); await restoreRoute(); }
  catch (error) { showDashboard(false); $("#project-list").innerHTML = '<div class="empty-state"><h2>项目暂时没有加载成功</h2><p>请检查连接后重试。</p><button class="secondary" id="retry-projects">重新加载</button></div>'; $("#retry-projects").onclick = () => run(initialize); toast(error.message); }
}
function configureShell() {
  $("#user-badge").textContent = `${state.user.display_name} · ${roleLabel(state.user.role)}`;
  $("#users-button").classList.toggle("hidden", state.user.role !== "admin");
  $("#audit-button").classList.toggle("hidden", !["admin","designer"].includes(state.user.role));
  $("#new-project-button").classList.toggle("hidden", !["designer", "admin"].includes(state.user.role));
}
async function login(event) {
  event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('[type="submit"]'); if (button.disabled) return; button.disabled = true; button.textContent = "正在进入…";
  try { const result = await api("/api/login", { method: "POST", body: Object.fromEntries(new FormData(event.currentTarget)) }); state.csrf = result.csrf_token; sessionStorage.setItem("designHubCsrf", state.csrf); state.user = result.user; $("#auth-message").textContent = ""; await initialize(); }
  catch (error) { $("#auth-message").textContent = error.message; }
  finally { button.disabled = false; button.textContent = "进入设计空间"; }
}
async function register(event) {
  event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('[type="submit"]'); if (button.disabled) return; button.disabled = true;
  try { const result = await api("/api/register", { method: "POST", body: Object.fromEntries(new FormData(form)) }); $("#auth-message").textContent = result.message; form.reset(); }
  catch (error) { $("#auth-message").textContent = error.message; }
  finally { button.disabled = false; }
}
async function logout() { try { await api("/api/logout", { method: "POST" }); } catch {} sessionStorage.removeItem("designHubCsrf"); location.reload(); }

async function loadProjects() {
  state.projects = (await api("/api/projects")).projects;
  state.projectPreviews = new Map(); state.spotlightProjectId = state.projects[0]?.id || null;
  $("#studio-showcase").innerHTML = '<div class="showcase-placeholder"><span class="brand-symbol">✳</span><p>为好设计，留一个位置。</p></div>';
  $("#project-count").textContent = state.projects.length;
  $("#spotlight-open").disabled = !state.spotlightProjectId;
  renderProjects(); loadProjectPreviews();
}
function renderProjects() {
  const list = $("#project-list"); list.innerHTML = "";
  const query = $("#project-search").value.trim().toLocaleLowerCase();
  const projects = state.projects.filter((project) => `${project.name} ${project.description || ""}`.toLocaleLowerCase().includes(query));
  projects.forEach((project, index) => {
    const button = document.createElement("button"); button.className = "project-card";
    button.dataset.projectId = project.id; button.style.setProperty("--card-tone", index % 2 ? "#e3f1ed" : "#e6ebff");
    button.innerHTML = `<div class="project-card-preview"><span class="project-monogram">${escapeHtml(project.name.slice(0, 2))}</span><span class="project-role">${escapeHtml(roleLabel(project.access_role))}</span></div><div class="project-card-info"><div><strong>${escapeHtml(project.name)}</strong><p>${escapeHtml(project.description && project.description !== project.name ? project.description : "团队的设计与交付资源")}</p></div><span class="project-enter">${icon("arrow-right")}</span></div><div class="project-card-meta"><span class="project-board-count">正在读取设计稿…</span><span>更新于 ${formatDate(project.updated_at)}</span></div>`;
    button.addEventListener("click", () => run(() => openProject(project.id))); list.append(button); paintProjectPreview(project.id);
  });
  if (!projects.length) list.innerHTML = `<div class="empty-state">${icon(query ? "search" : "folder", 32)}<h2>${query ? "没有匹配的项目" : "为团队的第一个设计留个位置"}</h2><p>${query ? "换个关键词，或清空搜索查看全部项目。" : ["designer", "admin"].includes(state.user.role) ? "点击「新建项目」，再从 Sketch 同步选中的画板。" : "请联系项目负责人，将你添加到需要参与的项目。"}</p></div>`;
}
async function loadProjectPreviews() {
  // 同时最多读取两个项目，预览失败不阻挡用户进入项目；不缓存到浏览器磁盘。
  const projects = [...state.projects]; const cache = state.projectPreviews;
  await Promise.all([0, 1].map(async () => {
    while (projects.length) { const project = projects.shift(); try { const result = await api(`/api/projects/${project.id}/artboards`); if (cache !== state.projectPreviews) return; cache.set(project.id, result.artboards); } catch { cache.set(project.id, null); } paintProjectPreview(project.id); }
  }));
}
function paintProjectPreview(id) {
  if (!state.projectPreviews.has(id)) return;
  const boards = state.projectPreviews.get(id); const card = $$(".project-card").find((el) => el.dataset.projectId === id);
  const previewBoards = (boards || []).filter((board) => board.current_version_id).slice(0, 3);
  const thumbnails = previewBoards.map((board, index) => `<img class="cover-artboard cover-${index}" src="/api/versions/${encodeURIComponent(board.current_version_id)}/preview" alt="" loading="lazy" decoding="async">`).join("");
  if (card) { card.querySelector(".project-board-count").textContent = boards ? `${boards.length} 张设计稿` : "打开项目查看设计稿"; const cover = card.querySelector(".project-card-preview"); cover.querySelectorAll("img").forEach((el) => el.remove()); cover.insertAdjacentHTML("beforeend", thumbnails); cover.classList.toggle("has-previews", Boolean(previewBoards.length)); }
  if (id === state.spotlightProjectId) { const project = state.projects.find((item) => item.id === id); if (previewBoards.length) $("#studio-showcase").innerHTML = `<div class="showcase-boards">${thumbnails.replaceAll('loading="lazy"', 'loading="eager"')}</div><div class="showcase-detail">${icon("image", 16)}<span>真实画板 · 即刻交接</span><b>${boards.length} 张</b></div>`; $("#spotlight-caption").textContent = `${project?.name || "项目"}${boards ? ` / ${boards.length} 张设计稿` : ""} · 最近更新`; }
}
function setRoute(path, replace = false) { history[replace ? "replaceState" : "pushState"]({}, "", path); }
function shellMode(mode) { $("#app-view").dataset.mode = mode; }
function setSidebarCollapsed(kind, collapsed) {
  state[`${kind}SidebarCollapsed`] = collapsed;
  if (kind === "stage") { $("#stage-sidebar").classList.toggle("collapsed", collapsed); $("#stage-sidebar").inert = collapsed; $("#stage-sidebar-open").classList.toggle("hidden", !collapsed); return; }
  $("#viewer-view").classList.toggle("sidebar-collapsed", collapsed); $("#viewer-sidebar").inert = collapsed; $("#viewer-sidebar-open").classList.toggle("hidden", !collapsed);
}
async function restoreRoute() {
  if (connectSectionFromPath()) return initializeConnect();
  const next = new URLSearchParams(location.search).get("next");
  if (state.user && ["/connect/sketch", "/connect/mcp", "/connect/guide"].includes(next)) { setRoute(next, true); return initializeConnect(); }
  if (!state.user) return showOnly("#auth-view");
  const detail = location.pathname.match(/^\/projects\/([^/]+)\/artboards\/([^/]+)$/);
  const project = location.pathname.match(/^\/projects\/([^/]+)$/);
  try {
    if (detail) { await openProject(detail[1], false); await openArtboard(detail[2], false); return; }
    if (project) { await openProject(project[1], false); return; }
  } catch (error) { toast(error.message); }
  showDashboard(false); setRoute("/", true);
}
function showDashboard(push = true) {
  state.navigationEpoch++; state.versionEpoch++; $("#ai-context-link").removeAttribute("href");
  state.project = null; showWorkspace("#dashboard-view"); $("#home-button").classList.add("hidden");
  $("#delete-project-button").classList.add("hidden");
  $("#topbar-title").textContent = "Design Hub"; $("#crumb").textContent = "项目"; $("#members-button").classList.add("hidden");
  $("#recycle-button").classList.toggle("hidden", !["designer", "admin"].includes(state.user.role));
  shellMode("dashboard"); if (push) setRoute("/");
}
async function openProject(projectId, push = true) {
  const epoch = ++state.navigationEpoch; state.versionEpoch++; const done = beginLoading("正在打开项目…");
  try {
  const [detail, folders, boards] = await Promise.all([api(`/api/projects/${projectId}`), api(`/api/projects/${projectId}/folders`), api(`/api/projects/${projectId}/artboards`)]);
  if (epoch !== state.navigationEpoch) return;
  state.project = detail.project; state.folders = folders.folders; state.artboards = boards.artboards; state.folderId = null; state.stageSelectedId = null;
  state.stageSelectedFolderId = null; $("#stage-search").value = ""; $("#viewer-search").value = ""; $("#ai-context-link").removeAttribute("href");
  state.expandedFolders = new Set([...state.expandedFolders].filter((id) => state.folders.some((folder) => folder.id === id)));
  if (!state.expandedFolders.size && state.folders[0]) state.expandedFolders.add(state.folders[0].id);
  $("#home-button").classList.remove("hidden"); $("#topbar-title").textContent = state.project.name; $("#crumb").textContent = "设计";
  const canEdit = ["editor", "owner", "admin"].includes(state.project.access_role); const canManage = ["owner", "admin"].includes(state.project.access_role);
  $("#delete-project-button").classList.toggle("hidden", !canManage);
  $("#new-folder-button").classList.toggle("hidden", !canEdit); $("#members-button").classList.toggle("hidden", !canManage); $("#recycle-button").classList.toggle("hidden", !canEdit);
  showWorkspace("#stage-view"); shellMode("stage"); setSidebarCollapsed("stage", innerWidth < 760 || state.stageSidebarCollapsed); renderGroups(); renderStage(); requestAnimationFrame(fitStage); if (push) setRoute(`/projects/${projectId}`);
  } finally { done(); }
}
function boardsInView() { return state.folderId ? state.artboards.filter((board) => board.folder_id === state.folderId) : state.artboards; }
function renderGroups() {
  $("#stage-group-title").textContent = "全部"; $("#stage-count").textContent = state.artboards.length; renderFolderTree("#folder-list", "stage");
}
function renderFolderTree(selector, mode) {
  const target = $(selector); const query = $(`#${mode}-search`).value.trim().toLocaleLowerCase();
  target.innerHTML = state.folders.map((folder) => { const folderMatch = folder.name.toLocaleLowerCase().includes(query); const boards = state.artboards.filter((board) => board.folder_id === folder.id && (!query || folderMatch || board.name.toLocaleLowerCase().includes(query))); if (query && !folderMatch && !boards.length) return ""; const expanded = Boolean(query) || state.expandedFolders.has(folder.id); const activeId = mode === "viewer" ? state.artboard?.id : state.stageSelectedId; return `<section class="folder-node${expanded ? " expanded" : ""}"><button class="folder-row${mode === "stage" && folder.id === state.stageSelectedFolderId ? " active" : ""}" data-tree-folder="${folder.id}" aria-expanded="${expanded}" title="${escapeHtml(folder.name)}"><span class="folder-chevron">${icon("chevron-right", 14)}</span><span class="folder-icon">${icon("folder", 17)}</span><span>${escapeHtml(folder.name)}</span><small>${boards.length}</small></button><div class="folder-artboards">${boards.map((board) => `<button class="folder-artboard${board.id === activeId ? " active" : ""}" data-tree-board="${board.id}" title="${escapeHtml(board.name)}" ${board.id === activeId ? 'aria-current="true"' : ""}><span>${icon("image", 16)}</span><span>${escapeHtml(board.name)}</span></button>`).join("")}</div></section>`; }).join("") || `<p class="muted tree-empty">${query ? "没有找到匹配的设计稿或目录" : "还没有目录，先从 Sketch 同步设计。"}</p>`;
  target.querySelectorAll("[data-tree-folder]").forEach((button) => button.addEventListener("click", () => { const id = button.dataset.treeFolder; if (state.expandedFolders.has(id)) state.expandedFolders.delete(id); else state.expandedFolders.add(id); if (mode === "stage") { state.stageSelectedFolderId = id; state.stageSelectedId = null; renderGroups(); renderStage(); focusStageFolder(id); } else renderDesignList(); }));
  target.querySelectorAll("[data-tree-board]").forEach((button) => { const id = button.dataset.treeBoard; button.addEventListener("click", () => { if (mode === "viewer") return run(() => openArtboard(id)); const board = state.artboards.find((item) => item.id === id); state.stageSelectedId = id; state.stageSelectedFolderId = board?.folder_id || null; renderGroups(); renderStage(); focusStageBoard(id); }); if (mode === "stage") { button.addEventListener("dblclick", () => run(() => openArtboard(id))); button.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); run(() => openArtboard(id)); } }); } });
}
function boardPositions(boards) {
  if (!boards.length) return { positions: [], sections: [] };
  const grouped = new Map();
  boards.forEach((board) => { const items = grouped.get(board.folder_id) || []; items.push(board); grouped.set(board.folder_id, items); });
  const positions = []; const sections = []; let cursorY = 140; const baseX = 360;
  state.folders.forEach((folder) => { const items = grouped.get(folder.id); if (!items?.length) return;
    const minX = Math.min(...items.map((item) => Number(item.canvas_x || 0))); const minY = Math.min(...items.map((item) => Number(item.canvas_y || 0)));
    const seen = new Set(); const sectionStart = cursorY; let sectionBottom = sectionStart; let sectionRight = baseX;
    items.sort((a, b) => Number(a.canvas_x) - Number(b.canvas_x) || Number(a.canvas_y) - Number(b.canvas_y)).forEach((board, index) => {
      let x = baseX + Number(board.canvas_x || 0) - minX; let y = sectionStart + Number(board.canvas_y || 0) - minY; const key = `${Math.round(x)}:${Math.round(y)}`;
      if (seen.has(key)) { x = baseX + (index % 6) * 470; y = sectionStart + Math.floor(index / 6) * 980; }
      seen.add(`${Math.round(x)}:${Math.round(y)}`); positions.push({ board, x, y }); sectionBottom = Math.max(sectionBottom, y + Number(board.height || 0)); sectionRight = Math.max(sectionRight, x + Number(board.width || 0));
    });
    sections.push({ folder, x: baseX - 48, y: sectionStart - 104, width: sectionRight - baseX + 96, height: sectionBottom - sectionStart + 152, labelX: baseX, labelY: sectionStart - 72, count: items.length });
    cursorY = sectionBottom + 220;
  }); return { positions, sections };
}
function renderStage() {
  const world = $("#stage-world"); world.innerHTML = "";
  $("#stage-empty").classList.toggle("hidden", Boolean(state.artboards.length));
  $("#stage-open-selected").classList.toggle("hidden", !state.stageSelectedId);
  const layout = boardPositions(boardsInView());
  layout.sections.forEach(({ folder, x, y, width, height, labelX, labelY, count }) => { const surface = document.createElement("div"); surface.className = `stage-folder-surface${folder.id === state.stageSelectedFolderId ? " selected" : ""}`; surface.dataset.folderId = folder.id; surface.style.cssText = `left:${x}px;top:${y}px;width:${width}px;height:${height}px`; world.append(surface); const label = document.createElement("div"); label.className = "stage-folder-label"; label.style.cssText = `left:${labelX}px;top:${labelY}px`; label.innerHTML = `<strong>${escapeHtml(folder.name)}</strong><span>${count} 个设计稿</span>`; world.append(label); });
  layout.positions.forEach(({ board, x, y }) => {
    const node = document.createElement("button"); node.className = `stage-board${state.stageSelectedId === board.id ? " selected" : ""}`; node.dataset.boardId = board.id;
    node.style.cssText = `left:${x}px;top:${y}px;width:${board.width}px;height:${board.height}px`;
    node.innerHTML = `<span class="stage-board-name">${escapeHtml(board.name)}</span><span class="stage-board-frame"><img src="/api/versions/${board.current_version_id}/preview" alt=""></span>`;
    node.addEventListener("click", (event) => { event.stopPropagation(); state.stageSelectedId = board.id; state.stageSelectedFolderId = board.folder_id; $$(".stage-board").forEach((element) => element.classList.toggle("selected", element.dataset.boardId === board.id)); $$(".stage-folder-surface").forEach((element) => element.classList.toggle("selected", element.dataset.folderId === board.folder_id)); $("#stage-open-selected").classList.remove("hidden"); renderGroups(); });
    node.addEventListener("dblclick", (event) => { event.stopPropagation(); run(() => openArtboard(board.id)); });
    node.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); run(() => openArtboard(board.id)); } });
    node.querySelector("img").decoding = "async"; world.append(node);
  }); updateStageTransform();
}
let cameraFrame = 0;
function stopCameraMotion() { cancelAnimationFrame(cameraFrame); cameraFrame = 0; }
function moveStageCamera(target, animated = true) {
  // 相机数值每帧回写真实状态，拖动/滚轮可立即接管，不等待预设动画结束。
  stopCameraMotion(); const from = { x: state.stagePan.x, y: state.stagePan.y, zoom: state.stageZoom }; const start = performance.now();
  const frame = (now) => { const elapsed = Math.min(1, (now - start) / 420); const t = reducedMotion.matches || !animated || elapsed === 1 ? 1 : 1 - (1 + elapsed * 9) * Math.exp(-elapsed * 9); state.stagePan.x = from.x + (target.x - from.x) * t; state.stagePan.y = from.y + (target.y - from.y) * t; state.stageZoom = from.zoom + (target.zoom - from.zoom) * t; updateStageTransform(); if (t < 1) cameraFrame = requestAnimationFrame(frame); else cameraFrame = 0; };
  frame(start);
}
function focusStageBox(box, maxZoom = 1.15, animated = true) {
  const viewport = $("#stage-viewport").getBoundingClientRect(); const leftInset = state.stageSidebarCollapsed || viewport.width < 760 ? 24 : 330; const availableWidth = Math.max(160, viewport.width - leftInset - 40); const availableHeight = Math.max(160, viewport.height - 120);
  const zoom = Math.min(maxZoom, Math.max(.03, Math.min(availableWidth / box.width, availableHeight / box.height))); moveStageCamera({ zoom, x: leftInset + (availableWidth - box.width * zoom) / 2 - box.x * zoom, y: 45 + (availableHeight - box.height * zoom) / 2 - box.y * zoom }, animated);
}
function focusStageBoard(id) { const node = $(`.stage-board[data-board-id="${id}"]`); if (!node) return; focusStageBox({ x: parseFloat(node.style.left) - 34, y: parseFloat(node.style.top) - 48, width: parseFloat(node.style.width) + 68, height: parseFloat(node.style.height) + 96 }, 1); }
function focusStageFolder(id) { const node = $(`.stage-folder-surface[data-folder-id="${id}"]`); if (!node) return; focusStageBox({ x: parseFloat(node.style.left), y: parseFloat(node.style.top), width: parseFloat(node.style.width), height: parseFloat(node.style.height) }, 1.05); }
function updateStageTransform() { $("#stage-world").style.transform = `translate(${state.stagePan.x}px, ${state.stagePan.y}px) scale(${state.stageZoom})`; $("#stage-zoom-output").value = `${Math.round(state.stageZoom * 100)}%`; }
function setStageZoom(next, anchorX, anchorY) {
  stopCameraMotion();
  const rect = $("#stage-viewport").getBoundingClientRect(); const x = anchorX ?? rect.width / 2; const y = anchorY ?? rect.height / 2; const previous = state.stageZoom;
  const clamped = Math.min(2.5, Math.max(0.03, next)); const worldX = (x - state.stagePan.x) / previous; const worldY = (y - state.stagePan.y) / previous;
  state.stageZoom = clamped; state.stagePan.x = x - worldX * clamped; state.stagePan.y = y - worldY * clamped; updateStageTransform();
}
function fitStage() {
  const boards = [...$("#stage-world").querySelectorAll(".stage-board")]; if (!boards.length) return;
  const viewport = $("#stage-viewport").getBoundingClientRect(); const boxes = boards.map((board) => ({ x: parseFloat(board.style.left), y: parseFloat(board.style.top) - 34, width: parseFloat(board.style.width), height: parseFloat(board.style.height) + 34 }));
  const minX = Math.min(...boxes.map((b) => b.x)); const minY = Math.min(...boxes.map((b) => b.y)); const maxX = Math.max(...boxes.map((b) => b.x + b.width)); const maxY = Math.max(...boxes.map((b) => b.y + b.height));
  focusStageBox({ x: minX - 24, y: minY - 40, width: maxX - minX + 48, height: maxY - minY + 64 }, 1.5);
}
function setupStageInteractions() {
  const viewport = $("#stage-viewport"); let drag = null;
  viewport.addEventListener("pointerdown", (event) => { if (event.button !== 0 && event.button !== 1) return; if (event.target.closest(".stage-board") && !state.spacePressed && event.button !== 1) return; stopCameraMotion(); event.preventDefault(); drag = { x: event.clientX, y: event.clientY, panX: state.stagePan.x, panY: state.stagePan.y }; viewport.setPointerCapture(event.pointerId); viewport.classList.add("dragging"); });
  viewport.addEventListener("pointermove", (event) => { if (!drag) return; state.stagePan.x = drag.panX + event.clientX - drag.x; state.stagePan.y = drag.panY + event.clientY - drag.y; updateStageTransform(); });
  const stop = () => { drag = null; viewport.classList.remove("dragging"); };
  viewport.addEventListener("pointerup", stop); viewport.addEventListener("pointercancel", stop);
  viewport.addEventListener("wheel", (event) => {
    event.preventDefault();
    stopCameraMotion(); if (event.metaKey || event.ctrlKey) { const rect = viewport.getBoundingClientRect(); setStageZoom(state.stageZoom * Math.exp(-event.deltaY * 0.002), event.clientX - rect.left, event.clientY - rect.top); return; }
    state.stagePan.x -= event.deltaX; state.stagePan.y -= event.deltaY; updateStageTransform();
  }, { passive: false });
}

async function openArtboard(artboardId, push = true) {
  const epoch = ++state.navigationEpoch; state.versionEpoch++; const done = beginLoading("正在打开设计稿…");
  try {
  const result = await api(`/api/artboards/${artboardId}`); if (epoch !== state.navigationEpoch) return; state.artboard = result.artboard; state.artboard.versions = result.versions;
  state.expandedFolders.add(state.artboard.folder_id);
  $("#viewer-title").textContent = state.artboard.name; $("#delete-artboard").classList.toggle("hidden", !["editor", "owner", "admin"].includes(state.artboard.access_role)); $("#ai-context-link").href = `/api/artboards/${artboardId}/ai-context`;
  const select = $("#version-select"); select.innerHTML = result.versions.map((version) => `<option value="${version.id}">版本 ${version.version_no} · ${formatDate(version.created_at)}</option>`).join(""); select.value = state.artboard.current_version_id;
  renderDesignList(); showWorkspace("#viewer-view"); shellMode("viewer"); setSidebarCollapsed("viewer", innerWidth < 960 || state.viewerSidebarCollapsed); await loadVersion(select.value); if (push && epoch === state.navigationEpoch) setRoute(`/projects/${state.project.id}/artboards/${artboardId}`);
  } finally { done(); }
}
function renderDesignList() {
  $("#viewer-board-count").textContent = state.artboards.length; renderFolderTree("#viewer-folder-list", "viewer");
}
async function loadVersion(versionId) {
  const epoch = ++state.versionEpoch; const artboard = state.artboard; const done = beginLoading("正在读取设计标注…");
  state.version = null; $("#copy-screen-prompt").disabled = true;
  $("#canvas-stage").classList.add("is-loading"); $("#canvas-stage").inert = true; closeInspector();
  try {
    const version = await api(`/api/versions/${versionId}`); if (epoch !== state.versionEpoch) return;
    // 先完成解码再展示新画板，快速切版本时旧请求不能覆盖新图或标注。
    const image = new Image(); image.src = version.version.preview_url; await image.decode(); if (epoch !== state.versionEpoch) return;
    state.version = version; state.layerRects = new Map(); $("#viewer-version-label").textContent = `版本 ${version.version.version_no} / ${displayNumber(artboard.width, "")} × ${displayNumber(artboard.height, "")} pt`;
    $("#properties-panel").innerHTML = ""; $("#version-select").value = versionId;
    const preview = $("#artboard-preview"); preview.src = image.src; preview.alt = `${artboard.name}，版本 ${version.version.version_no}`;
    const width = Number(artboard.width) || image.naturalWidth; const height = Number(artboard.height) || image.naturalHeight;
    preview.style.width = `${width}px`; preview.style.height = `${height}px`; $("#canvas-stage").style.width = `${width}px`; $("#canvas-stage").style.height = `${height}px`; renderLayerOverlay(width, height); fitViewer();
    $("#canvas-stage").classList.remove("is-loading"); $("#canvas-stage").inert = false; $("#copy-screen-prompt").disabled = false; $("#viewer-empty").textContent = "点击图层查看标注 · 空格拖动 · 按 0 适应窗口";
  } catch (error) { if (epoch !== state.versionEpoch) return; $("#viewer-empty").innerHTML = '<span>设计稿加载失败</span><button class="secondary" id="retry-version">重试</button>'; $("#retry-version").onclick = () => run(() => loadVersion(versionId)); throw error; }
  finally { done(); }
}
function metadataRoot() { return state.version?.metadata?.artboard || state.version?.metadata || {}; }
function layerChildren(layer) { return layer.layers || layer.children || []; }
// 与服务端 ai_layout 使用同一身份来源，旧版 Sketch 导出将真实 UUID 放在 var。
function layerId(layer) { return layer?.id || layer?.objectID || layer?.var || ""; }
function flattenLayers(layers, parentX = 0, parentY = 0, output = [], depth = 0, path = "", parentKey = null, parentHidden = false) {
  layers.forEach((layer, index) => { const frame = layer.frame || {}; const itemPath = `${path}.${index}`; const key = layerId(layer) || `layer-${itemPath}`; const item = { key, parentKey, layer, depth, path: itemPath, hidden: parentHidden || Boolean(layer.hidden), x: parentX + Number(frame.x || 0), y: parentY + Number(frame.y || 0), width: Number(frame.width || 0), height: Number(frame.height || 0) }; output.push(item); flattenLayers(layerChildren(layer), item.x, item.y, output, depth + 1, item.path, key, item.hidden); }); return output;
}
function layerAtPoint(items, x, y, selected = null) {
  let hit = null;
  for (const item of items) {
    if (item.hidden || item.layer.hidden || item.layer.isMask || item.width <= 0 || item.height <= 0 || item.key === selected?.key) continue;
    if (x < item.x || x > item.x + item.width || y < item.y || y > item.y + item.height) continue;
    // 同框背景不产生距离，继续检查真实子层或父容器，不能让装饰热点挡住测量。
    if (selected && !measurementGaps(selected, item).length) continue;
    const area = item.width * item.height; const hitArea = hit ? hit.width * hit.height : Infinity;
    if (area < hitArea || (area === hitArea && item.depth > hit.depth)) hit = item;
  }
  return hit;
}
function renderLayerOverlay(width, height) {
  const overlay = $("#layer-overlay"); overlay.innerHTML = ""; overlay.style.width = `${width}px`; overlay.style.height = `${height}px`; clearMeasurements();
  const items = flattenLayers(layerChildren(metadataRoot())); state.layerRects = new Map(items.map((item) => [item.key, item]));
  // 保留有界 DOM 按钮供键盘访问；鼠标按完整几何命中，不再漏掉细线或第 350 层之后的图层。
  items.filter((item) => !item.hidden && !item.layer.isMask && item.width > 0 && item.height > 0).slice(0, 350).forEach((item) => {
    const key = item.key; const button = document.createElement("button"); button.className = "layer-hotspot"; button.dataset.layerKey = key;
    button.style.cssText = `left:${item.x}px;top:${item.y}px;width:${item.width}px;height:${item.height}px;z-index:${2 + item.depth}`; button.title = item.layer.name || "图层"; button.setAttribute("aria-label", `查看 ${item.layer.name || "图层"} 的标注`);
    button.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); selectLayer(key); } });
    overlay.append(button);
  });
  const point = (event) => { const rect = overlay.getBoundingClientRect(); return { x: (event.clientX - rect.left) / state.zoom, y: (event.clientY - rect.top) / state.zoom }; };
  // 事件绑定在唯一画布上，切版本时覆盖旧处理器；悬停不再依赖热点的 z-index 和 pointerleave 顺序。
  overlay.onpointermove = (event) => {
    if (!state.selectedLayer || state.spacePressed || $("#canvas-scroll").classList.contains("dragging")) return clearMeasurements();
    const { x, y } = point(event); const target = layerAtPoint(items, x, y, state.selectedLayer);
    const board = { key: "artboard-bounds", x: 0, y: 0, width, height };
    showMeasurements(target || board);
  };
  overlay.onpointerleave = clearMeasurements;
  overlay.onclick = (event) => {
    if (state.spacePressed) return;
    const { x, y } = point(event); const hit = layerAtPoint(items, x, y);
    if (hit) return selectLayer(hit.key);
    closeInspector();
  };
}
function selectLayer(key) { const item = state.layerRects.get(key); if (!item) return; clearMeasurements(); state.selectedLayer = item; state.exportScopeKey = null; state.exportIncludeShadows = true; $$(".layer-hotspot").forEach((element) => element.classList.toggle("active", element.dataset.layerKey === key)); renderProperties(item); $("#viewer-view").classList.remove("inspector-closed"); $(".inspector-panel").inert = false; }
function measurementGaps(a, b) {
  const gaps = [];
  // 两条轴独立比较：分离时量最近边；投影重叠时量两端边界差，覆盖父子、交叉和部分重叠。
  for (const axis of ["x", "y"]) {
    const size = axis === "x" ? "width" : "height"; const cross = axis === "x" ? "y" : "x"; const crossSize = axis === "x" ? "height" : "width";
    const a1 = a[axis]; const a2 = a1 + a[size]; const b1 = b[axis]; const b2 = b1 + b[size];
    const pairs = a2 <= b1 ? [[a2, b1]] : b2 <= a1 ? [[b2, a1]] : [[a1, b1], [a2, b2]];
    const at = overlapCenter(a[cross], a[cross] + a[crossSize], b[cross], b[cross] + b[crossSize]);
    for (const [start, end] of pairs) { if (Math.abs(end - start) > .01) gaps.push({ axis, from: Math.min(start, end), to: Math.max(start, end), at }); }
  }
  return gaps;
}
function showMeasurements(target) {
  const hover = typeof target === "string" ? state.layerRects.get(target) : target;
  if (!state.selectedLayer || !hover || hover.key === state.selectedLayer.key) return clearMeasurements();
  const overlay = $("#measurement-overlay"); if (overlay.dataset.target === hover.key) return;
  clearMeasurements(); overlay.dataset.target = hover.key;
  const outline = document.createElement("div"); outline.className = "measurement-target"; outline.style.cssText = `left:${hover.x}px;top:${hover.y}px;width:${hover.width}px;height:${hover.height}px`; overlay.append(outline);
  for (const gap of measurementGaps(state.selectedLayer, hover)) {
    const horizontal = gap.axis === "x"; const line = document.createElement("div"); line.className = `measure-line ${horizontal ? "horizontal" : "vertical"}`;
    line.style.cssText = horizontal ? `left:${gap.from}px;top:${gap.at}px;width:${gap.to - gap.from}px` : `left:${gap.at}px;top:${gap.from}px;height:${gap.to - gap.from}px`;
    const label = document.createElement("div"); label.className = "measure-label"; label.style.cssText = `left:${horizontal ? (gap.from + gap.to) / 2 : gap.at}px;top:${horizontal ? gap.at : (gap.from + gap.to) / 2}px`; label.textContent = displayNumber(gap.to - gap.from);
    overlay.append(line, label);
  }
}
function overlapCenter(a1, a2, b1, b2) { const start = Math.max(a1, b1); const end = Math.min(a2, b2); return start <= end ? (start + end) / 2 : a2 < b1 ? (a2 + b1) / 2 : (b2 + a1) / 2; }
function clearMeasurements() { const overlay = $("#measurement-overlay"); overlay.replaceChildren(); delete overlay.dataset.target; }
function valuePresent(value) { return value !== undefined && value !== null && value !== ""; }
function displayNumber(value, suffix = "pt") { return valuePresent(value) && Number.isFinite(Number(value)) ? `${Math.round(Number(value) * 100) / 100}${suffix}` : "—"; }
function displayPercent(value) { if (!valuePresent(value)) return "—"; const number = Number(value); return `${Math.round((number <= 1 ? number * 100 : number) * 100) / 100}%`; }
function field(label, value, wide = false) { const plain = valuePresent(value) ? String(value) : "—"; return `<div class="spec-field${wide ? " wide" : ""}"><span>${escapeHtml(label)}</span><strong class="copy-target" data-copy-value="${escapeHtml(plain)}" title="双击复制">${escapeHtml(plain)}</strong></div>`; }
function inlineField(label, value) { const plain = valuePresent(value) ? String(value) : "—"; return `<span class="inline-field"><b>${escapeHtml(label)}</b><strong class="copy-target" data-copy-value="${escapeHtml(plain)}" title="双击复制">${escapeHtml(plain)}</strong></span>`; }
async function copyPropertyValue(element) {
  const content = element.dataset.copyValue ?? element.textContent.trim();
  await copyText(content); toast("已复制");
}
function swatch(color) { return color ? `<i class="color-swatch" style="background:${escapeHtml(color)}"></i>` : ""; }
function colorValue(color) { return color ? `${swatch(color)}<code>${escapeHtml(color)}</code>` : '<span class="muted">无</span>'; }
function colorDetails(color, layerOpacity = 1) {
  const match = String(color || "").match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i); if (!match) return { hex: color || "—", opacity: displayPercent(layerOpacity) };
  const alpha = match[2] ? parseInt(match[2], 16) / 255 : 1; return { hex: `#${match[1].toUpperCase()}`, opacity: displayPercent(alpha * Number(layerOpacity ?? 1)) };
}
function fontWeightLabel(weight) { return ({ 1:"UltraLight", 2:"Thin", 3:"Light", 4:"Book", 5:"Regular", 6:"Medium", 7:"DemiBold", 8:"SemiBold", 9:"Bold", 10:"ExtraBold", 11:"Heavy", 12:"Black", 13:"UltraBlack" })[Number(weight)] || (valuePresent(weight) ? String(weight) : "—"); }
function alignmentLabel(value) { return ({ left:"左对齐", center:"居中对齐", right:"右对齐", justified:"两端对齐", natural:"自然对齐", top:"顶部对齐", middle:"垂直居中", bottom:"底部对齐" })[String(value || "").toLowerCase()] || value || "—"; }
function textOptionLabel(value, labels) { return valuePresent(value) ? (labels[String(value).toLowerCase()] || String(value)) : "重新同步后获取"; }
function textRow(label, content, className = "") { return `<div class="text-spec-row ${className}"><span>${escapeHtml(label)}</span><div class="text-spec-value">${content}</div></div>`; }
function renderTextSection(text, layerOpacity) {
  const color = colorDetails(text.color, layerOpacity); const missing = "重新同步后获取";
  const value = (content, className = "") => { const plain = String(content ?? "—"); return `<strong class="copy-target ${className}" data-copy-value="${escapeHtml(plain)}" title="双击复制">${escapeHtml(plain)}</strong>`; };
  const fontName = text.fontName || text.fontFamily || "—";
  return `<div class="text-section">
    ${textRow("内容", value(text.content ?? "", "text-content"), "text-content-row full")}
    ${textRow("字体名称", value(fontName))}
    ${textRow("PostScript", value(text.fontPostscriptName || missing))}
    ${textRow("字体族", value(text.fontFamily || "—"))}
    ${textRow("字体样式", value(text.fontStyle || fontWeightLabel(text.fontWeight)))}
    ${textRow("字重", value(fontWeightLabel(text.fontWeight)))}
    ${textRow("文字装饰", value(text.textDecoration === "" ? "无" : textOptionLabel(text.textDecoration, { none:"无", underline:"下划线", "line-through":"删除线" })))}
    ${textRow("水平对齐", value(alignmentLabel(text.alignment)))}
    ${textRow("垂直对齐", value(valuePresent(text.verticalAlignment) ? alignmentLabel(text.verticalAlignment) : missing))}
    ${textRow("颜色", `<div class="text-color-value">${swatch(text.color)}${value(color.hex)}${value(color.opacity)}</div>`)}
    <div class="text-numeric-row">
      ${textRow("字号", value(displayNumber(text.fontSize)), "compact")}
      ${textRow("行高", value(valuePresent(text.lineHeight) ? displayNumber(text.lineHeight) : "自动"), "compact")}
      ${textRow("大小写", value(textOptionLabel(text.textTransform, { none:"无", uppercase:"全大写", lowercase:"全小写" })), "compact")}
    </div>
    ${textRow("字间距", value(displayNumber(text.kerning ?? 0)))}
    ${textRow("段落间距", value(displayNumber(text.paragraphSpacing ?? 0)))}
  </div>`;
}
function fillCard(fill, index) {
  // Sketch 会给纯色填充附带默认渐变配置，只有 Gradient 类型才能展示为渐变。
  const type = String(fill.fillType || (fill.gradient ? "Gradient" : "Color")); const gradient = type.toLowerCase() === "gradient" ? fill.gradient : null;
  let details = `<div class="style-line"><span>颜色</span><strong>${colorValue(fill.color)}</strong></div>`;
  if (gradient) {
    const stops = (gradient.stops || []).map((stop) => `<div class="color-stop">${colorValue(stop.color)}<span>${displayPercent(stop.position)}</span></div>`).join("");
    details = `<div class="style-line"><span>渐变类型</span><strong>${escapeHtml(gradient.type || type)}</strong></div>${gradient.from && gradient.to ? `<div class="style-line"><span>起点 → 终点</span><strong>${displayNumber(gradient.from.x, "")}, ${displayNumber(gradient.from.y, "")} → ${displayNumber(gradient.to.x, "")}, ${displayNumber(gradient.to.y, "")}</strong></div>` : ""}<div class="gradient-stops">${stops || '<span class="muted">没有渐变色标</span>'}</div>`;
  }
  return `<article class="style-card"><header><strong>填充 ${index + 1}</strong><span>${escapeHtml(type)}</span></header><div class="style-card-fields">${details}<div class="style-line"><span>不透明度</span><strong>${displayPercent(fill.opacity ?? 1)}</strong></div>${fill.blendMode ? `<div class="style-line"><span>混合模式</span><strong>${escapeHtml(fill.blendMode)}</strong></div>` : ""}</div></article>`;
}
function borderCard(border, index) { return `<article class="style-card"><header><strong>边框 ${index + 1}</strong><span>${escapeHtml(border.position || "")}</span></header><div class="style-card-fields"><div class="style-line"><span>颜色</span><strong>${colorValue(border.color)}</strong></div><div class="style-line"><span>粗细</span><strong>${displayNumber(border.thickness)}</strong></div></div></article>`; }
function shadowCard(shadow, index) { return `<article class="style-card"><header><strong>阴影 ${index + 1}</strong></header><div class="style-line"><span>颜色</span><strong>${colorValue(shadow.color)}</strong></div><div class="spec-grid compact">${field("X", displayNumber(shadow.x))}${field("Y", displayNumber(shadow.y))}${field("模糊", displayNumber(shadow.blur))}${field("扩展", displayNumber(shadow.spread))}</div></article>`; }
function assetsForLayer(layer, kind = "slice") {
  const id = layerId(layer); const name = String(layer?.name || "");
  return (state.version?.assets || []).filter((asset) => asset.kind === kind && ((id && asset.layer_id === id) || (!id && name && asset.name === name)));
}
function exportScopes(item) {
  if (!item) return [];
  const current = { key: `layer:${item.key}`, kind: "layer", item, members: [item], label: `当前图层 · ${item.layer.name || item.layer.type}` }; const parents = []; let parent = state.layerRects.get(item.parentKey);
  while (parent) { if (!parent.layer.isMask && ["Group", "SymbolInstance", "SymbolMaster"].includes(parent.layer.type)) parents.push({ key: `parent:${parent.key}`, kind: "layer", item: parent, members: [parent], label: `完整控件 · ${parent.layer.name}` }); parent = state.layerRects.get(parent.parentKey); }
  return [...parents, current];
}
function itemFrame(item) { return { x: item.x, y: item.y, width: item.width, height: item.height }; }
function influenceBounds(item) {
  let left = 0, right = 0, top = 0, bottom = 0; (item.layer.style?.shadows || []).filter((shadow) => shadow.enabled !== false).forEach((shadow) => { const reach = Number(shadow.blur || 0) + Number(shadow.spread || 0); left = Math.max(left, reach - Number(shadow.x || 0)); right = Math.max(right, reach + Number(shadow.x || 0)); top = Math.max(top, reach - Number(shadow.y || 0)); bottom = Math.max(bottom, reach + Number(shadow.y || 0)); }); return { x: item.x - left, y: item.y - top, width: item.width + left + right, height: item.height + top + bottom };
}
function mergeBounds(boxes) { const x = Math.min(...boxes.map((box) => box.x)); const y = Math.min(...boxes.map((box) => box.y)); const right = Math.max(...boxes.map((box) => box.x + box.width)); const bottom = Math.max(...boxes.map((box) => box.y + box.height)); return { x, y, width: right - x, height: bottom - y }; }
function renderedBounds(item) { return mergeBounds([item, ...state.layerRects.values()].filter((candidate) => candidate === item || candidate.path.startsWith(`${item.path}.`)).map(influenceBounds)); }
function scopeBounds(scope, includeShadows = true) { return mergeBounds(scope.members.map((item) => includeShadows ? renderedBounds(item) : itemFrame(item))); }
function layerHasShadow(layer) { return (layer.style?.shadows || []).some((shadow) => shadow.enabled !== false) || layerChildren(layer).some(layerHasShadow); }
function scopeHasShadow(scope) { return scope.members.some((item) => layerHasShadow(item.layer)); }
function exportAssetsForItem(item, includeShadows) { return !includeShadows && layerHasShadow(item.layer) ? assetsForLayer(item.layer, "slice-no-shadow") : assetsForLayer(item.layer); }
function scopeSelector(scopes, scope) { return scopes.length > 1 ? `<label class="scope-label">导出范围<select id="export-scope">${scopes.map((candidate) => `<option value="${candidate.key}" ${candidate.key === scope.key ? "selected" : ""}>${escapeHtml(candidate.label)}</option>`).join("")}</select></label>` : ""; }
function exportPanel(layer) {
  if (!state.selectedLayer) return "";
  const scopes = exportScopes(state.selectedLayer); if (!scopes.length) return ""; if (!state.exportScopeKey || !scopes.some((scope) => scope.key === state.exportScopeKey)) state.exportScopeKey = scopes[0].key; const scope = scopes.find((candidate) => candidate.key === state.exportScopeKey) || scopes[0]; const assets = assetsForLayer(scope.item.layer); const hasShadow = scopeHasShadow(scope); const includeShadows = !hasShadow || state.exportIncludeShadows; const exportAssets = exportAssetsForItem(scope.item, includeShadows); const pngs = exportAssets.filter((asset) => asset.format === "png"); const preview = [...pngs].sort((a, b) => b.scale - a.scale)[0] || exportAssets[0]; const missing = scope.members.filter((item) => !exportAssetsForItem(item, includeShadows).some((asset) => asset.format === "png"));
  if (scope.kind === "layer" && !assets.length) return `<section class="property-group export-section"><h3>导出</h3>${scopeSelector(scopes, scope)}<p class="export-empty">该范围还没有独立资源。请用更新后的 Sketch 插件重新同步。</p></section>`;
  const formats = scope.kind === "composite" || !includeShadows ? ["png", "jpg"] : ["png", "jpg", ...(assets.some((asset) => asset.format === "svg") ? ["svg"] : [])]; const bounds = scopeBounds(scope, includeShadows); const members = scope.kind === "composite" ? `<div class="composite-members"><strong>组合图层</strong>${scope.members.filter((item) => !item.layer.isMask).map((item) => `<span>${icon("image", 14)}${escapeHtml(item.layer.name || item.layer.type)}</span>`).join("")}</div>` : ""; const canvasPreview = scope.kind === "composite"; const previewHtml = canvasPreview ? '<div class="asset-preview"><canvas id="composite-preview"></canvas></div>' : (preview ? `<div class="asset-preview"><img src="${preview.download_url}" alt="切图预览"></div>` : ""); const shadowOption = hasShadow ? `<label class="export-shadow-option"><input id="export-shadow" type="checkbox" ${includeShadows ? "checked" : ""}><span>包含阴影</span><small>${includeShadows ? "按 Sketch 效果导出" : "使用无阴影原图"}</small></label>` : ""; const missingLabel = !includeShadows ? "无阴影资源" : "透明资源";
  return `<section class="property-group export-section"><h3>导出</h3>${scopeSelector(scopes, scope)}${members}${previewHtml}${shadowOption}${missing.length ? `<p class="export-empty">缺少 ${missing.map((item) => escapeHtml(item.layer.name)).join("、")} 的${missingLabel}，请从 Sketch 重新同步一次。</p>` : ""}<div class="export-selects"><label>下载切图样式<select id="export-format">${formats.map((format) => `<option value="${format}">${format.toUpperCase()}</option>`).join("")}</select></label><label>切图使用平台<select id="export-platform"><option value="ios">iOS</option><option value="android">Android</option><option value="flutter">Flutter</option></select></label></div><div id="export-scales" class="export-scales" data-width="${bounds.width}" data-height="${bounds.height}"></div><button id="export-assets" class="export-button" ${missing.length ? "disabled" : ""}>导出资源</button></section>`;
}
function renderProperties(item, exportSettings = null) {
  const layer = item?.layer || item || {}; const target = $("#properties-panel"); const frame = item?.layer ? itemFrame(item) : (layer.frame || {}); const style = layer?.style || {}; const text = layer?.text || {};
  const fills = (style.fills || []).filter((item) => item.enabled !== false); const borders = (style.borders || []).filter((item) => item.enabled !== false); const shadows = (style.shadows || []).filter((item) => item.enabled !== false);
  target.innerHTML = `<section class="property-group"><h3 title="X / Y 为相对于画板的坐标">位置与尺寸</h3><div class="dimension-list"><div class="dimension-row">${inlineField("X", displayNumber(frame.x))}${inlineField("Y", displayNumber(frame.y))}</div><div class="dimension-row three">${inlineField("宽度", displayNumber(frame.width))}${inlineField("高度", displayNumber(frame.height))}${inlineField("旋转", displayNumber(layer?.rotation, "°"))}</div></div></section><section class="property-group"><h3>样式</h3>${text.content !== undefined ? renderTextSection(text, style.opacity ?? layer?.opacity ?? 1) : ""}<div class="style-inline-grid">${inlineField("不透明度", displayPercent(style.opacity ?? layer?.opacity ?? 1))}${inlineField("圆角", displayNumber(style.cornerRadius))}</div>${fills.map(fillCard).join("")}${borders.map(borderCard).join("")}${shadows.map(shadowCard).join("")}${style.blur?.enabled ? `<article class="style-card"><header><strong>模糊</strong><span>${escapeHtml(style.blur.type || "")}</span></header><div class="style-line"><span>半径</span><strong>${displayNumber(style.blur.radius)}</strong></div></article>` : ""}</section>${exportPanel(layer)}`;
  target.ondblclick = (event) => { const value = event.target.closest(".copy-target, .style-line strong, .style-card code, .color-stop span"); if (value && !event.target.closest("button")) run(() => copyPropertyValue(value)); };
  bindExportControls(item, exportSettings);
}
function bindExportControls(item, exportSettings = null) {
  const scopeSelect = $("#export-scope"); if (scopeSelect) scopeSelect.addEventListener("change", () => { state.exportScopeKey = scopeSelect.value; state.exportIncludeShadows = true; renderProperties(item); }); const platform = $("#export-platform"); if (!platform) return; const scopes = exportScopes(state.selectedLayer); const scope = scopes.find((candidate) => candidate.key === state.exportScopeKey) || scopes[0]; const bounds = scopeBounds(scope, state.exportIncludeShadows); const format = $("#export-format");
  if (exportSettings) { platform.value = exportSettings.platform; if ([...format.options].some((option) => option.value === exportSettings.format)) format.value = exportSettings.format; }
  const renderScales = (selected = platform.value === "ios" ? [2, 3] : [1, 2, 3]) => { const exportName = scope.item.layer.name || assetsForLayer(scope.item.layer)[0]?.name || "资源"; $("#export-scales").innerHTML = [1, 2, 3].map((scale) => `<label><input type="checkbox" value="${scale}" ${selected.includes(scale) ? "checked" : ""}><span title="${escapeHtml(exportName)} @${scale}x">${escapeHtml(exportName)} @${scale}x</span><small>${displayNumber(bounds.width * scale, "px")} × ${displayNumber(bounds.height * scale, "px")}</small></label>`).join(""); };
  platform.addEventListener("change", () => renderScales());
  $("#export-shadow")?.addEventListener("change", (event) => {
    state.exportIncludeShadows = event.target.checked;
    // 切换阴影只替换对应资源，保留用户的平台、格式、倍率与右侧面板滚动位置。
    const settings = { platform: platform.value, format: format.value, scales: $$("#export-scales input:checked").map((input) => Number(input.value)) }; const panel = $(".inspector-panel"); const scrollTop = panel.scrollTop;
    renderProperties(item, settings); panel.scrollTop = scrollTop;
  });
  renderScales(exportSettings?.scales); if ($("#composite-preview")) renderComposite(scope, 1, "png", $("#composite-preview"), state.exportIncludeShadows).catch(() => {}); $("#export-assets")?.addEventListener("click", () => exportSelectedAssets(scope));
}
function triggerDownload(url, filename) { const link = document.createElement("a"); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove(); }
function assetFilename(name, format, scale, platform) { const clean = String(name || "asset").replace(/[\\/:*?"<>|]/g, "-"); if (platform === "android") return `${clean}-${({1:"mdpi",2:"xhdpi",3:"xxhdpi"})[scale]}.${format}`; if (platform === "flutter") return `${scale}.0x-${clean}.${format}`; return `${clean}${scale === 1 ? "" : `@${scale}x`}.${format}`; }
async function loadAssetImage(item, scale, includeShadows = true) { const asset = exportAssetsForItem(item, includeShadows).find((candidate) => candidate.format === "png" && Number(candidate.scale) === scale); if (!asset) throw new Error(`缺少 ${item.layer.name} @${scale}x`); const image = new Image(); image.src = asset.download_url; await image.decode(); return image; }
async function renderComposite(scope, scale, format, targetCanvas = null, includeShadows = true) { const bounds = scopeBounds(scope, includeShadows); const canvas = targetCanvas || document.createElement("canvas"); canvas.width = Math.max(1, Math.round(bounds.width * scale)); canvas.height = Math.max(1, Math.round(bounds.height * scale)); const context = canvas.getContext("2d"); if (format === "jpg") { context.fillStyle = "#ffffff"; context.fillRect(0, 0, canvas.width, canvas.height); } for (const item of scope.members) { const image = await loadAssetImage(item, scale, includeShadows); const box = includeShadows ? renderedBounds(item) : itemFrame(item); context.drawImage(image, Math.round((box.x - bounds.x) * scale), Math.round((box.y - bounds.y) * scale), Math.round(box.width * scale), Math.round(box.height * scale)); } return canvas; }
function blobBase64(blob) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = reject; reader.readAsDataURL(blob); }); }
async function exportSelectedAssets(scope) {
  const layer = scope.item.layer; const assets = assetsForLayer(layer); const format = $("#export-format").value; const platform = $("#export-platform").value; const scales = $$("#export-scales input:checked").map((input) => Number(input.value)); if (!scales.length) return toast("至少选择一个倍率");
  const button = $("#export-assets"); button.disabled = true;
  try {
    if (scope.kind === "composite" || !state.exportIncludeShadows) { const files = []; for (const scale of scales) { const canvas = await renderComposite(scope, scale, format, null, state.exportIncludeShadows); const blob = await new Promise((resolve) => canvas.toBlob(resolve, format === "jpg" ? "image/jpeg" : "image/png", .95)); files.push({ name: assetFilename(layer.name, format, scale, platform), data_base64: await blobBase64(blob) }); } const packaged = await api("/api/exports/package", { method: "POST", body: { artboard_id: state.artboard.id, name: `${layer.name || "assets"}-${platform}.zip`, files } }); triggerDownload(packaged.download_url, packaged.filename); toast(`已导出 ${files.length} 个切图`); return; }
    const parameters = new URLSearchParams({ layer_id: layerId(layer), name: layer.name || assets[0]?.name || "asset", format, platform, scales: scales.join(",") }); triggerDownload(`/api/versions/${state.version.version.id}/export?${parameters}`, `${layer.name || "assets"}-${platform}.zip`); toast(`正在导出 ${scales.length} 个切图`);
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
}
function updateViewerTransform() {
  $("#canvas-stage").style.transform = `translate(${state.viewerPan.x}px, ${state.viewerPan.y}px) scale(${state.zoom})`;
  $("#canvas-stage").style.setProperty("--measurement-scale", 1 / state.zoom);
  const value = Math.round(state.zoom * 100); $("#zoom-range").value = value; $("#zoom-output").value = `${value}%`;
}
function setZoom(value, anchorX, anchorY) {
  const viewport = $("#canvas-scroll").getBoundingClientRect(); const x = anchorX ?? viewport.width / 2; const y = anchorY ?? viewport.height / 2; const previous = state.zoom;
  const next = Math.min(2.5, Math.max(0.2, Number(value) / 100)); const worldX = (x - state.viewerPan.x) / previous; const worldY = (y - state.viewerPan.y) / previous;
  state.zoom = next; state.viewerPan.x = x - worldX * next; state.viewerPan.y = y - worldY * next; updateViewerTransform();
}
function centerViewer() {
  const viewport = $("#canvas-scroll").getBoundingClientRect(); const width = Number(state.artboard?.width) || 0; const height = Number(state.artboard?.height) || 0;
  state.viewerPan.x = Math.max(60, (viewport.width - width * state.zoom) / 2); state.viewerPan.y = Math.max(60, (viewport.height - height * state.zoom) / 2); updateViewerTransform();
}
function fitViewer() { const rect = $("#canvas-scroll").getBoundingClientRect(); const width = Number(state.artboard?.width) || 390; const height = Number(state.artboard?.height) || 844; state.zoom = Math.max(.2, Math.min(1, (rect.width - 80) / width, (rect.height - 96) / height)); centerViewer(); }
function setupViewerInteractions() {
  const viewport = $("#canvas-scroll"); let drag = null;
  viewport.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 && event.button !== 1) return;
    if (event.target.closest("button") && !state.spacePressed && event.button !== 1) return;
    event.preventDefault();
    drag = { x: event.clientX, y: event.clientY, panX: state.viewerPan.x, panY: state.viewerPan.y }; viewport.setPointerCapture(event.pointerId); viewport.classList.add("dragging");
  });
  viewport.addEventListener("pointermove", (event) => { if (!drag) return; state.viewerPan.x = drag.panX + event.clientX - drag.x; state.viewerPan.y = drag.panY + event.clientY - drag.y; updateViewerTransform(); });
  const stop = () => { drag = null; viewport.classList.remove("dragging"); };
  viewport.addEventListener("pointerup", stop); viewport.addEventListener("pointercancel", stop);
  viewport.addEventListener("wheel", (event) => {
    event.preventDefault();
    if (event.metaKey || event.ctrlKey) { const rect = viewport.getBoundingClientRect(); setZoom(state.zoom * 100 * Math.exp(-event.deltaY * 0.002), event.clientX - rect.left, event.clientY - rect.top); return; }
    state.viewerPan.x -= event.deltaX; state.viewerPan.y -= event.deltaY; updateViewerTransform();
  }, { passive: false });
}

function promptDeviceClass(width) { return width <= 375 ? "小屏手机" : width < 768 ? "常规手机" : "大屏/平板"; }
function promptFrame(item, contentTop = 0) { return `x ${displayNumber(item.x, "")} · y ${displayNumber(item.y - contentTop, "")} · ${displayNumber(item.width, "")} × ${displayNumber(item.height, "")}pt`; }
function promptRegionKind(item, height) {
  const name = String(item.layer.name || "").toLowerCase(); const nearTop = item.y < height * .35; const nearBottom = item.y + item.height > height * .65;
  if (nearTop && /(status\s*bar|navigation\s*bar|nav\s*bar|app\s*bar|top\s*bar|状态栏|导航栏)/i.test(name)) return "top";
  if (nearBottom && /(tab\s*bar|bottom\s*(bar|navigation)|home\s*indicator|标签栏|底部导航)/i.test(name)) return "bottom";
  return "";
}
function promptStyle(layer) {
  const style = layer.style || {}; const parts = []; const fills = (style.fills || []).filter((item) => item.enabled !== false); const borders = (style.borders || []).filter((item) => item.enabled !== false); const shadows = (style.shadows || []).filter((item) => item.enabled !== false);
  if (fills[0]) parts.push(fills[0].gradient && String(fills[0].fillType || "Gradient").toLowerCase() === "gradient" ? `渐变 ${fills[0].gradient.type || fills[0].fillType || ""}` : `填充 ${fills[0].color || ""}`); if (valuePresent(style.cornerRadius)) parts.push(`圆角 ${displayNumber(style.cornerRadius)}`);
  if (borders[0]) parts.push(`边框 ${displayNumber(borders[0].thickness)} ${borders[0].color || ""}`); if (shadows[0]) parts.push(`阴影 ${displayNumber(shadows[0].x)} ${displayNumber(shadows[0].y)} ${displayNumber(shadows[0].blur)} ${shadows[0].color || ""}`); if (valuePresent(style.opacity) && Number(style.opacity) !== 1) parts.push(`透明度 ${displayPercent(style.opacity)}`);
  return parts.join("；");
}
function promptTextRule(item) {
  const text = item.layer.text; if (!text) return ""; const content = String(text.content || "").replace(/\n/g, " ↵ "); const size = Number(text.fontSize || 0); const lineHeight = Number(text.lineHeight || size * 1.2 || 1); const observedLines = Math.max(1, String(text.content || "").split("\n").length); const fittedLines = Math.max(observedLines, Math.floor(item.height / lineHeight)); const singleLine = fittedLines === 1; const numeric = /\d/.test(content); const scale = numeric ? .5 : .7;
  return `文字“${content.slice(0, 100)}${content.length > 100 ? "…" : ""}” · ${text.fontName || text.fontFamily || "字体未同步"} ${displayNumber(size)} / ${valuePresent(text.lineHeight) ? displayNumber(text.lineHeight) : "自动行高"} · ${text.color || "颜色未同步"} · 最多 ${fittedLines} 行${singleLine ? ` · 放不下时允许缩放至 ${scale}（推断建议）并尾部截断` : " · 超出后尾部截断（推断建议）"}`;
}
function rangesOverlap(a1, a2, b1, b2) { return Math.max(a1, b1) <= Math.min(a2, b2); }
function promptContains(outer, inner) { return outer !== inner && inner.x >= outer.x - .5 && inner.y >= outer.y - .5 && inner.x + inner.width <= outer.x + outer.width + .5 && inner.y + inner.height <= outer.y + outer.height + .5; }
function promptNeighbors(item, items) {
  const below = items.filter((other) => other !== item && other.y >= item.y + item.height && rangesOverlap(item.x, item.x + item.width, other.x, other.x + other.width)).sort((a, b) => a.y - (item.y + item.height) - (b.y - (item.y + item.height)))[0];
  const right = items.filter((other) => other !== item && other.x >= item.x + item.width && rangesOverlap(item.y, item.y + item.height, other.y, other.y + other.height)).sort((a, b) => a.x - (item.x + item.width) - (b.x - (item.x + item.width)))[0];
  return [below ? `下到“${below.layer.name}” ${displayNumber(below.y - item.y - item.height)}` : "", right ? `右到“${right.layer.name}” ${displayNumber(right.x - item.x - item.width)}` : ""].filter(Boolean).join("；");
}
function buildScreenPrompt() {
  const root = metadataRoot(); const width = Number(state.artboard?.width || root.frame?.width || 0); const height = Number(state.artboard?.height || root.frame?.height || 0); const all = flattenLayers(layerChildren(root)).filter((item) => !item.layer.hidden && item.width > 1 && item.height > 1); const byKey = new Map(all.map((item) => [item.key, item]));
  let topRegions = all.filter((item) => promptRegionKind(item, height) === "top"); let bottomRegions = all.filter((item) => promptRegionKind(item, height) === "bottom"); const topInferred = !topRegions.length; const bottomInferred = !bottomRegions.length; if (topInferred) topRegions = all.filter((item) => item.depth <= 1 && item.x <= width * .08 && item.y <= 20 && item.width >= width * .84 && item.height >= 20 && item.height <= 140).slice(0, 2); if (bottomInferred) bottomRegions = all.filter((item) => item.depth <= 1 && item.x <= width * .08 && item.y + item.height >= height - 20 && item.width >= width * .84 && item.height >= 20 && item.height <= 140).slice(0, 2); const contentTop = topRegions.length ? Math.max(...topRegions.map((item) => item.y + item.height)) : 0; const contentBottom = bottomRegions.length ? Math.min(...bottomRegions.map((item) => item.y)) : height; const contentHeight = Math.max(0, contentBottom - contentTop);
  const candidates = all.filter((item) => { const centerY = item.y + item.height / 2; if (centerY < contentTop || centerY > contentBottom || item.layer.isMask) return false; const type = String(item.layer.type || ""); if (item.width >= width * .95 && item.height >= height * .8) return false; return ["Text","Bitmap","Image","SymbolInstance"].includes(type) || (type === "Group" && item.depth <= 1) || (["Shape","ShapePath"].includes(type) && item.depth === 0); }).slice(0, 160).sort((a, b) => a.y - b.y || a.x - b.x || a.depth - b.depth);
  const regionLine = (items, empty, inferred) => items.length ? `${inferred ? "[几何推断，需复核] " : ""}${items.map((item) => `“${item.layer.name}” ${promptFrame(item)}`).join("；")}` : empty;
  const components = candidates.map((item, index) => { const parent = byKey.get(item.parentKey); const visualParent = parent ? null : candidates.filter((candidate) => promptContains(candidate, item)).sort((a, b) => a.width * a.height - b.width * b.height)[0]; const container = parent || visualParent; const parentInset = container ? `${visualParent ? `视觉上位于“${container.layer.name}”内（位置推断，不改变图层或导出范围）` : "父容器"}：上 ${displayNumber(item.y - container.y)}、左 ${displayNumber(item.x - container.x)}、右 ${displayNumber(container.x + container.width - item.x - item.width)}、下 ${displayNumber(container.y + container.height - item.y - item.height)}` : "画板直属图层"; const detail = [promptTextRule(item), promptStyle(item.layer), promptNeighbors(item, candidates)].filter(Boolean).join("；"); return `${index + 1}. ${item.layer.name || item.layer.type} [${item.layer.type || "Layer"}]：${promptFrame(item, contentTop)}；${parentInset}${detail ? `；${detail}` : ""}`; }).join("\n");
  return `请按照以下设计标注实现“${state.artboard?.name || root.name || "未命名界面"}”。遵循现有项目技术栈与设计系统，不要把整张设计图当图片铺上去。\n\n【事实与推断边界】\n- 标有“推断建议”或“几何推断”的内容不是 Sketch 原始参数，可结合产品语义调整。\n- 未提供的交互态、动态数据、键盘行为和滚动边界不得自行杜撰。\n- 坐标单位为设计逻辑单位；iOS 按 pt、Android 按 dp/sp、Web 按 CSS px 映射。\n\n【设备基准】\n- 参考画板：${displayNumber(width, "")} × ${displayNumber(height, "")}pt，属于${promptDeviceClass(width)}。\n- 小屏（≤375pt）：保持左右安全间距，内容不足时优先压缩弹性间距；单行动态文字最低缩放 0.5～0.7。\n- 常规屏（390～430pt）：按参考画板相对间距布局。\n- 大屏/平板（≥768pt）：内容区设置合理 maxWidth 后居中，不要横向无限拉伸。\n\n【系统上下区域】\n- 顶部状态栏/NavigationBar：${regionLine(topRegions, "未可靠识别，不得假定为内容区；实现时使用平台 safe area 复核。", topInferred)}\n- 底部 TabBar/Home Indicator：${regionLine(bottomRegions, "未可靠识别；如产品实际存在，必须从内容区剥离。", bottomInferred)}\n- 内容区：绝对 y=${displayNumber(contentTop, "")}～${displayNumber(contentBottom, "")}，高度 ${displayNumber(contentHeight)}。下方所有 y 坐标均已换算为内容区坐标，禁止再次叠加状态栏、NavigationBar 或 TabBar 高度。\n\n【布局原则】\n- 优先使用安全区、相对约束、Stack/Flex/Grid 和内容内边距；不要照抄整屏绝对坐标。\n- 保持组件顺序、对齐线、左右边距和相邻间距；重复元素用同一组件与统一间距。\n- 固定尺寸只用于图标、切图和设计明确固定的控件；容器宽度优先随可用空间变化。\n- 文本最多行数按当前文本框容量生成；单行动态数字可缩放至 0.5，普通按钮/标签文字可缩放至 0.7，多行文字优先换行后截断。\n\n【内容区组件】\n${components || "没有可用的语义图层，请检查 Sketch 图层命名与同步数据。"}\n${all.length > candidates.length ? `\n注：已省略背景和内部矢量路径，只保留最多 160 个对开发有意义的组件；原始可见图层 ${all.length} 个。` : ""}\n\n【资源与验收】\n- 图片、图标使用 Design Hub 导出的本地资源和正确倍率，不引用远程设计地址。\n- 实现后分别以小屏、参考尺寸、大屏/平板检查：safe area、导航/TabBar 剥离、左右间距、组件间距、文字换行/缩放、图片裁剪和滚动范围。`;
}
async function copyScreenPrompt() {
  if (!state.artboard || !state.version) return toast("请先打开一个设计稿"); const text = buildScreenPrompt();
  await copyText(text);
  toast(`已复制界面提示词 · ${text.length} 字`);
}
async function copyAiLink() {
  if (!state.artboard) return toast("请先打开一个设计稿"); const url = `${location.origin}/ai/artboards/${state.artboard.id}`; await copyText(url); toast("AI 自描述链接已复制");
}

async function createProject() { const values = await promptDialog("新建项目", [{ name: "name", label: "项目名称", required: true }, { name: "description", label: "说明" }]); if (!values) return; const result = await api("/api/projects", { method: "POST", body: values }); toast("项目已创建"); await loadProjects(); await openProject(result.id); }
async function createFolder() { const values = await promptDialog("新建分组", [{ name: "name", label: "分组名称", required: true }]); if (!values) return; await api(`/api/projects/${state.project.id}/folders`, { method: "POST", body: values }); toast("分组已创建"); await openProject(state.project.id, false); }
function promptDialog(title, fields, confirmLabel = "保存") { const dialog = $("#simple-dialog"); dialog.returnValue = "cancel"; $("#dialog-title").textContent = title; $("#dialog-confirm").textContent = confirmLabel; $("#dialog-content").innerHTML = fields.map((field) => `<label>${escapeHtml(field.label)}<input name="${escapeHtml(field.name)}" value="${escapeHtml(field.value || '')}" ${field.maxLength ? `maxlength="${Number(field.maxLength)}"` : ''} ${field.type === "password" ? 'type="password" minlength="8" autocomplete="new-password"' : ""} ${field.required ? "required" : ""}></label>`).join(""); dialog.showModal(); return new Promise((resolve) => dialog.addEventListener("close", () => { resolve(dialog.returnValue === "default" ? Object.fromEntries(new FormData($("#dialog-form"))) : null); $("#dialog-form").reset(); }, { once: true })); }

async function openUsers() {
  const result = await api("/api/users"); $("#management-title").textContent = "人员管理";
  $("#management-content").innerHTML = `<table class="management-table"><thead><tr><th>人员</th><th>账号</th><th>系统身份</th><th>操作</th></tr></thead><tbody>${result.users.map((user) => `<tr><td>${escapeHtml(user.display_name)}</td><td>${escapeHtml(user.username)}</td><td><select data-user-role="${user.id}">${["pending","developer","designer","admin","disabled"].map((role) => `<option value="${role}" ${role === user.role ? "selected" : ""}>${roleLabel(role)}</option>`).join("")}</select></td><td><button class="secondary" data-save-user="${user.id}">保存</button> <button class="ghost" data-reset-password="${user.id}">重置密码</button></td></tr>`).join("")}</tbody></table>`; $("#management-dialog").showModal();
  $$('[data-save-user]').forEach((button) => button.addEventListener("click", async (event) => { event.preventDefault(); try { await api(`/api/users/${button.dataset.saveUser}`, { method: "PATCH", body: { role: $(`[data-user-role="${button.dataset.saveUser}"]`).value } }); toast("用户身份已更新"); } catch (error) { toast(error.message); } }));
  $$('[data-reset-password]').forEach((button) => button.addEventListener("click", async (event) => { event.preventDefault(); $("#management-dialog").close(); const values = await promptDialog("重置密码", [{ name: "password", label: "新密码（至少 8 位）", type: "password", required: true }]); if (!values) return; try { await api(`/api/users/${button.dataset.resetPassword}`, { method: "PATCH", body: values }); toast("密码已重置，旧会话已退出"); } catch (error) { toast(error.message); } }));
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch (_) { const area = document.createElement("textarea"); area.value = text; area.style.position = "fixed"; area.style.opacity = "0"; const previous = document.activeElement; (document.querySelector("dialog[open]") || document.body).append(area); area.select(); const copied = document.execCommand("copy"); area.remove(); previous?.focus(); if (!copied) throw new Error("浏览器未允许复制，请使用 HTTPS 或本机地址后重试"); }
}
async function openApiKeys() {
  const result = await api("/api/api-keys"); const dialog = $("#management-dialog"); $("#management-title").textContent = "AI API Key";
  $("#management-content").innerHTML = `<div class="member-add"><button type="button" id="create-api-key" class="primary">创建 Key</button></div><table class="management-table api-key-table"><thead><tr><th>别名</th><th>完整 Key</th><th>创建时间</th><th>操作</th></tr></thead><tbody>${result.api_keys.map((key) => `<tr><td><button type="button" class="ghost" data-edit-api-key="${key.id}" title="点击修改别名" aria-label="修改别名：${escapeHtml(key.name)}">${escapeHtml(key.name)}</button></td><td>${key.token ? `<code class="api-key-value"><span class="api-key-start">${escapeHtml(key.token.slice(0,-8))}</span><span class="api-key-end">${escapeHtml(key.token.slice(-8))}</span></code>` : `<code>${escapeHtml(key.token_prefix)}…</code><small>旧版 Key 原文不可恢复</small>`}</td><td>${formatDate(key.created_at)}</td><td class="api-key-actions"><button type="button" class="secondary" data-copy-api-key="${key.id}" ${key.token ? '' : 'disabled title="旧版 Key 未保存原文，无法复制"'}>复制</button> <button type="button" class="ghost danger" data-revoke-api-key="${key.id}">删除</button></td></tr>`).join("") || '<tr><td colspan="4">还没有 API Key</td></tr>'}</tbody></table>`;
  if (!dialog.open) dialog.showModal();
  $$('[data-copy-api-key]').forEach(button => button.addEventListener('click', () => run(async () => { await copyText(result.api_keys.find(key => key.id === button.dataset.copyApiKey).token); toast('Key 已复制'); })));
  $("#create-api-key").addEventListener("click", () => run(() => editApiKeyAlias()));
  $$('[data-edit-api-key]').forEach(button => button.addEventListener('click', () => run(() => editApiKeyAlias(result.api_keys.find(key => key.id === button.dataset.editApiKey)))));
  $$('[data-revoke-api-key]').forEach((button) => button.addEventListener("click", async () => { if (!confirm("删除后，此 Key 立即失效并从列表移除，使用它的客户端需要更换 Key。确认删除？")) return; try { await api(`/api/api-keys/${button.dataset.revokeApiKey}`, { method: "DELETE" }); await openApiKeys(); toast("API Key 已删除"); } catch (error) { toast(error.message); } }));
}
async function editApiKeyAlias(key = null) {
  // 先关闭列表弹窗再编辑，避免嵌套表单的提交同时关闭两个对话框。
  $("#management-dialog").close();
  try {
    const values = await promptDialog(key ? "修改 Key 别名" : "创建 Key", [{name:"name",label:"别名（可选，留空使用默认名称）",value:key?.name || "",maxLength:80}], key ? "保存" : "继续");
    if (!values) return;
    const name = values.name.trim() || "AI 只读访问";
    await api(key ? `/api/api-keys/${key.id}` : "/api/api-keys", {method:key ? "PATCH" : "POST",body:key ? {name,purpose:key.purpose || ""} : {name}});
    toast(key ? "别名已更新" : "Key 已创建");
  } finally { await openApiKeys(); }
}
async function openMembers() {
  const result = await api(`/api/projects/${state.project.id}/members`); $("#management-title").textContent = `${state.project.name} · 项目成员`; const available = result.candidates.filter((candidate) => !result.members.some((member) => member.id === candidate.id));
  $("#management-content").innerHTML = `<div class="member-add"><select id="member-candidate"><option value="">选择人员</option>${available.map((user) => `<option value="${user.id}">${escapeHtml(user.display_name)} · ${roleLabel(user.role)}</option>`).join("")}</select><select id="member-new-role"><option value="viewer">Viewer</option><option value="editor">Editor</option><option value="owner">Owner</option></select><button id="member-add-button" class="primary">添加</button></div><table class="management-table"><thead><tr><th>人员</th><th>系统身份</th><th>项目角色</th><th>操作</th></tr></thead><tbody>${result.members.map((member) => `<tr><td>${escapeHtml(member.display_name)}</td><td>${roleLabel(member.system_role)}</td><td><select data-member-role="${member.id}">${["viewer","editor","owner"].map((role) => `<option value="${role}" ${role === member.project_role ? "selected" : ""}>${roleLabel(role)}</option>`).join("")}</select></td><td><button class="secondary" data-save-member="${member.id}">保存</button> <button class="ghost danger" data-remove-member="${member.id}">移除</button></td></tr>`).join("")}</tbody></table>`; $("#management-dialog").showModal();
  $("#member-add-button").addEventListener("click", async (event) => { event.preventDefault(); try { await api(`/api/projects/${state.project.id}/members`, { method: "POST", body: { user_id: $("#member-candidate").value, role: $("#member-new-role").value } }); $("#management-dialog").close(); toast("项目成员已添加"); } catch (error) { toast(error.message); } });
  $$('[data-save-member]').forEach((button) => button.addEventListener("click", async (event) => { event.preventDefault(); try { await api(`/api/projects/${state.project.id}/members/${button.dataset.saveMember}`, { method: "PATCH", body: { role: $(`[data-member-role="${button.dataset.saveMember}"]`).value } }); toast("项目角色已更新"); } catch (error) { toast(error.message); } }));
  $$('[data-remove-member]').forEach((button) => button.addEventListener("click", async (event) => { event.preventDefault(); if (!confirm("确认移除该项目成员？")) return; try { await api(`/api/projects/${state.project.id}/members/${button.dataset.removeMember}`, { method: "DELETE" }); button.closest("tr").remove(); toast("项目成员已移除"); } catch (error) { toast(error.message); } }));
}
async function deleteCurrentArtboard() { if (!confirm(`将“${state.artboard.name}”移入回收站？`)) return; await api(`/api/artboards/${state.artboard.id}`, { method: "DELETE" }); toast("设计稿已移入回收站"); await openProject(state.project.id); }
async function deleteCurrentProject() {
  const project = state.project;
  if (!project || !confirm(`将整个项目“${project.name}”移入回收站？其目录、画板和资源将停止访问，Owner 或管理员可恢复。`)) return;
  await api(`/api/projects/${project.id}`, {method:'DELETE'});
  state.artboard = null; showDashboard(); await loadProjects(); toast('整个项目已移入回收站');
}

async function openAudit(before = null, action = null) {
  const selectedAction = action === null ? ($('#audit-action')?.value || '') : action;
  const query = new URLSearchParams({limit:'50'});
  if (before) query.set('before',before);
  if (state.project && ['owner','admin'].includes(state.project.access_role)) query.set('project_id',state.project.id);
  if (selectedAction) query.set('action',selectedAction);
  const result = await api('/api/audit?' + query);
  $('#management-title').textContent = state.project && ['owner','admin'].includes(state.project.access_role) ? `${state.project.name} · 操作历史` : state.user.role === 'admin' ? '全站操作历史' : '我负责的项目 · 操作历史';
  const actions = {'':'全部操作','project.delete':'删除项目','project.restore':'恢复项目','member.upsert':'添加/分配成员','member.update':'修改成员','member.remove':'移除成员','artboard.created':'新增画板','artboard.updated':'更新画板','request.GET':'查看/下载请求','request.POST':'提交/上传请求','request.PATCH':'修改请求','request.DELETE':'删除请求'};
  const labels = {...actions,'project.create':'创建项目','project.purge':'永久删除项目','folder.create':'创建目录','session.login':'登录','session.logout':'退出','api_key.create':'创建Key','api_key.update':'修改Key说明','api_key.revoke':'撤销Key','artboard.delete':'删除画板','artboard.restore':'恢复画板','artboard.purge':'永久删除画板','user.update':'修改用户','user.register':'注册'};
  $('#management-content').innerHTML = `<p class="management-note">记录业务变更及 API 请求结果，包含失败、MCP 读取和下载；不记录 Key、密码或请求正文。旧版未记录的历史无法补回。</p><label>操作筛选<select id="audit-action">${Object.entries(actions).map(([key,label])=>`<option value="${key}" ${key===selectedAction?'selected':''}>${label}</option>`).join('')}</select></label><table class="management-table"><thead><tr><th>时间 / 操作人</th><th>操作</th><th>对象</th><th>详情</th></tr></thead><tbody>${result.logs.map(log=>`<tr><td>${formatDate(log.created_at)}<br>${escapeHtml(log.actor_name || '未认证请求')}</td><td>${escapeHtml(labels[log.action] || log.action)}</td><td>${escapeHtml(log.object_type)}<br>${escapeHtml(log.object_id || '')}</td><td><code class="key-value">${escapeHtml(log.details_json)}</code></td></tr>`).join('') || '<tr><td colspan="4">暂无操作记录</td></tr>'}</tbody></table><div class="member-add"><button id="audit-first" class="secondary">返回最新</button><button id="audit-next" class="secondary" ${result.next_cursor ? '' : 'disabled'}>更早记录</button></div>`;
  if (!$('#management-dialog').open) $('#management-dialog').showModal();
  $('#audit-action').addEventListener('change',()=>run(()=>openAudit(null,$('#audit-action').value)));
  $('#audit-first').onclick=()=>run(()=>openAudit(null,selectedAction));
  $('#audit-next').onclick=()=>run(()=>openAudit(result.next_cursor,selectedAction));
}
async function openRecycle() {
  const result = await api("/api/recycle"); $("#management-title").textContent = "回收站";
  const projectRows = result.projects.map((project) => `<tr><td>项目</td><td>${escapeHtml(project.name)}</td><td>${formatDate(project.deleted_at)}</td><td><button class="secondary" data-restore-project="${project.id}">恢复</button>${state.user.role === "admin" ? ` <button class="ghost danger" data-purge-project="${project.id}">永久删除</button>` : ""}</td></tr>`).join(""); const boardRows = result.artboards.map((board) => `<tr><td>设计稿</td><td>${escapeHtml(board.name)}</td><td>${formatDate(board.deleted_at)}</td><td><button class="secondary" data-restore-board="${board.id}">恢复</button>${state.user.role === "admin" ? ` <button class="ghost danger" data-purge-board="${board.id}">永久删除</button>` : ""}</td></tr>`).join("");
  $("#management-content").innerHTML = `<table class="management-table"><thead><tr><th>类型</th><th>名称</th><th>删除时间</th><th>操作</th></tr></thead><tbody>${projectRows + boardRows || '<tr><td colspan="4" class="table-empty">回收站是空的，所有设计都在原位。</td></tr>'}</tbody></table>`; $("#management-dialog").showModal();
  $$('[data-restore-project]').forEach((button) => button.addEventListener("click", async () => { await api(`/api/projects/${button.dataset.restoreProject}/restore`, { method: "POST" }); button.closest("tr").remove(); await loadProjects(); toast("项目已恢复"); }));
  $$('[data-restore-board]').forEach((button) => button.addEventListener("click", async () => { await api(`/api/artboards/${button.dataset.restoreBoard}/restore`, { method: "POST" }); button.closest("tr").remove(); toast("设计稿已恢复"); if (state.project) await openProject(state.project.id); }));
  $$('[data-purge-project]').forEach((button) => button.addEventListener("click", async () => { if (!confirm("永久删除项目及其全部文件？该操作无法恢复。")) return; await api(`/api/projects/${button.dataset.purgeProject}/purge`, { method: "DELETE" }); button.closest("tr").remove(); await loadProjects(); toast("项目已永久删除"); }));
  $$('[data-purge-board]').forEach((button) => button.addEventListener("click", async () => { if (!confirm("永久删除设计稿及全部版本？该操作无法恢复。")) return; await api(`/api/artboards/${button.dataset.purgeBoard}/purge`, { method: "DELETE" }); button.closest("tr").remove(); toast("设计稿已永久删除"); }));
}
function compact(value) { if (value === undefined || value === null) return ""; if (typeof value === "string" || typeof value === "number") return value; const text = JSON.stringify(value); return text.length > 120 ? `${text.slice(0, 117)}…` : text; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]); }
function formatDate(value) { return new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }); }

$$('[data-auth-tab]').forEach((button) => button.addEventListener("click", () => { $$('[data-auth-tab]').forEach((tab) => { tab.classList.toggle("active", tab === button); tab.setAttribute("aria-pressed", tab === button); }); $("#login-form").classList.toggle("hidden", button.dataset.authTab !== "login"); $("#register-form").classList.toggle("hidden", button.dataset.authTab !== "register"); $("#auth-message").textContent = ""; reveal($(`#${button.dataset.authTab}-form`)); }));
$("#login-form").addEventListener("submit", login); $("#register-form").addEventListener("submit", register); $("#logout-button").addEventListener("click", logout); $("#pending-logout").addEventListener("click", logout);
$("#home-button").addEventListener("click", () => showDashboard());
$("#delete-project-button").addEventListener("click", () => run(deleteCurrentProject));
$("#audit-button").addEventListener("click", () => run(() => openAudit(null,'')));
for (const [selector, action] of [["#new-project-button", createProject], ["#new-folder-button", createFolder], ["#users-button", openUsers], ["#api-keys-button", () => openApiKeys()], ["#members-button", openMembers], ["#recycle-button", openRecycle], ["#copy-screen-prompt", copyScreenPrompt], ["#copy-ai-link", copyAiLink], ["#delete-artboard", deleteCurrentArtboard]]) $(selector).addEventListener("click", () => run(action));
$("#back-to-stage").addEventListener("click", () => run(() => openProject(state.project.id))); $("#version-select").addEventListener("change", (event) => run(() => loadVersion(event.target.value))); $("#zoom-range").addEventListener("input", (event) => setZoom(event.target.value));
$("#stage-fit").addEventListener("click", fitStage); $("#stage-minus").addEventListener("click", () => setStageZoom(state.stageZoom / 1.15)); $("#stage-plus").addEventListener("click", () => setStageZoom(state.stageZoom * 1.15));
$("#stage-sidebar-close").addEventListener("click", () => setSidebarCollapsed("stage", true)); $("#stage-sidebar-open").addEventListener("click", () => setSidebarCollapsed("stage", false));
$("#viewer-sidebar-close").addEventListener("click", () => setSidebarCollapsed("viewer", true)); $("#viewer-sidebar-open").addEventListener("click", () => setSidebarCollapsed("viewer", false));
window.addEventListener("popstate", restoreRoute);
$("#project-search").addEventListener("input", renderProjects);
$("#stage-search").addEventListener("input", renderGroups);
$("#viewer-search").addEventListener("input", renderDesignList);
$("#spotlight-open").addEventListener("click", () => { if (state.spotlightProjectId) run(() => openProject(state.spotlightProjectId)); });
$("#stage-open-selected").addEventListener("click", () => { if (state.stageSelectedId) run(() => openArtboard(state.stageSelectedId)); });
$("#viewer-fit").addEventListener("click", fitViewer);
$("#inspector-close").addEventListener("click", () => { closeInspector(); $("#canvas-scroll").focus(); });
$("#help-button").addEventListener("click", openGuide); $$("[data-open-guide]").forEach((button) => button.addEventListener("click", openGuide));
// 管理弹窗沿用原生 dialog，内容区动作不应提交 method=dialog 而提前关闭。
$("#management-dialog form").addEventListener("submit", (event) => { if (event.submitter?.value !== "cancel") event.preventDefault(); });
$("#management-dialog").addEventListener("close", () => { $("#management-content").replaceChildren(); });
document.addEventListener("keydown", (event) => {
  if (document.querySelector("dialog[open]") || event.target.closest("input,textarea,select,[contenteditable=true]")) return;
  const mode = $("#app-view").dataset.mode; if ($("#app-view").classList.contains("hidden")) return;
  if (event.code === "Space" && !event.target.closest("button,a")) { state.spacePressed = true; document.body.classList.add("space-pan"); event.preventDefault(); }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === "/") { event.preventDefault(); if (mode === "stage") setSidebarCollapsed("stage", false); if (mode === "viewer") setSidebarCollapsed("viewer", false); $(`#${mode === "dashboard" ? "project" : mode}-search`)?.focus(); }
  if (event.key === "0") { event.preventDefault(); if (mode === "stage") fitStage(); else if (mode === "viewer") fitViewer(); }
  if (event.key === "Escape" && mode === "viewer") { closeInspector(); $("#canvas-scroll").focus(); }
  if (event.key === "Enter" && mode === "stage" && state.stageSelectedId && !event.target.closest("button,a")) run(() => openArtboard(state.stageSelectedId));
});
const releaseSpace = () => { state.spacePressed = false; document.body.classList.remove("space-pan"); };
document.addEventListener("keyup", (event) => { if (event.code === "Space") releaseSpace(); }); window.addEventListener("blur", releaseSpace);
document.addEventListener("error", (event) => { if (event.target.tagName === "IMG" && event.target.classList.contains("cover-artboard")) event.target.style.visibility = "hidden"; }, true);
document.addEventListener("load", (event) => { if (event.target.tagName === "IMG" && event.target.classList.contains("cover-artboard")) event.target.classList.add("loaded"); }, true);
window.addEventListener("resize", () => {
  if (innerWidth < 760) { setSidebarCollapsed("stage", true); setSidebarCollapsed("viewer", true); }
  if (!$("#viewer-view").classList.contains("hidden") && state.version) fitViewer();
  else if (!$("#stage-view").classList.contains("hidden")) fitStage();
});
setupConnect();
hydrateIcons();
initialize();
