const sketch = require("sketch");
const UI = require("sketch/ui");
const Settings = require("sketch/settings");
const timers = require("timers");

const SERVER_KEY = "designHub.serverURL";
const TOKEN_KEY = "designHub.sessionToken";
const USER_KEY = "designHub.username";
// 下载打包时由对应部署注入地址；直接安装源码时必须手动填写。
const BUNDLED_SERVER_URL = "";
const UPLOAD_CONCURRENCY = 1;

function schedule(callback) {
  // 使用 Sketch 公开的 timers 模块，由其 fiber 保持脚本存活并让出事件循环。
  return timers.setTimeout(callback, 20);
}

function normalizeServerURL(value) {
  let url = String(value || "").trim();
  while (url.endsWith("/")) url = url.slice(0, -1);
  const match = url.match(/^https?:\/\/(?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$/);
  if (!match || (match[1] && (Number(match[1]) < 1 || Number(match[1]) > 65535))) throw new Error("请填写服务器地址，例如 http://192.168.1.100:8765，不包含账号或其他路径");
  return url;
}

function serverURL() {
  return String(Settings.settingForKey(SERVER_KEY) || BUNDLED_SERVER_URL || "");
}

function nativeJSONRequest(method, path, body, token, selectedOrigin) {
  const origin = normalizeServerURL(selectedOrigin || serverURL());
  const requestURL = NSURL.URLWithString(origin + path);
  const nativeRequest = NSMutableURLRequest.requestWithURL(requestURL);
  nativeRequest.setHTTPMethod(method);
  nativeRequest.setTimeoutInterval(120);
  nativeRequest.setValue_forHTTPHeaderField("application/json", "Accept");
  if (token) nativeRequest.setValue_forHTTPHeaderField(`Bearer ${token}`, "Authorization");
  if (body !== undefined && body !== null) {
    nativeRequest.setValue_forHTTPHeaderField("application/json", "Content-Type");
    const payload = NSString.stringWithString(JSON.stringify(body)).dataUsingEncoding(NSUTF8StringEncoding);
    nativeRequest.setHTTPBody(payload);
  }
  return nativeRequest;
}

function parseResponse(data, response) {
  const text = data ? String(NSString.alloc().initWithData_encoding(data, NSUTF8StringEncoding)) : "";
  let result = {};
  try { result = text ? JSON.parse(text) : {}; } catch { throw new Error("服务端返回了无法解析的数据"); }
  if (!response || response.statusCode() < 200 || response.statusCode() >= 300) {
    if (response && response.statusCode() === 401) Settings.setSettingForKey(TOKEN_KEY, undefined);
    throw new Error(result.error || `请求失败 (${response ? response.statusCode() : "无响应"})`);
  }
  return result;
}

function request(method, path, body, token, selectedOrigin) {
  const nativeRequest = nativeJSONRequest(method, path, body, token, selectedOrigin);
  const responsePointer = MOPointer.alloc().init();
  const errorPointer = MOPointer.alloc().init();
  const data = NSURLConnection.sendSynchronousRequest_returningResponse_error(nativeRequest, responsePointer, errorPointer);
  const nativeError = errorPointer.value();
  if (nativeError) throw new Error(`连接失败：${nativeError.localizedDescription()}`);
  return parseResponse(data, responsePointer.value());
}

function configureServer() {
  const current = serverURL();
  UI.getInputFromUser("Design Hub 服务地址", { initialValue: current }, (error, value) => {
    if (error) return;
    try {
      Settings.setSettingForKey(SERVER_KEY, normalizeServerURL(value));
      Settings.setSettingForKey(TOKEN_KEY, undefined);
      UI.message("Design Hub 服务地址已保存");
    } catch (validationError) {
      UI.alert("配置失败", validationError.message);
    }
  });
}

function chooseUploadServer(callback) {
  UI.getInputFromUser("本次上传的服务器地址", {initialValue:serverURL(),description:"每次上传都可修改。切换服务器后需要重新登录。",okButton:"继续",cancelButton:"取消"}, (error, value) => {
    if (error) return;
    try {
      const selected = normalizeServerURL(value);
      if (selected !== serverURL()) Settings.setSettingForKey(TOKEN_KEY, undefined);
      Settings.setSettingForKey(SERVER_KEY, selected);
    } catch (validationError) { UI.alert("服务地址无效", validationError.message); return; }
    callback();
  });
}

function login(callback) {
  console.log("[DesignHub]:[Auth] 显示登录窗口");
  const alert = NSAlert.alloc().init();
  alert.setMessageText("登录 Design Hub");
  alert.setInformativeText("密码仅用于本次登录，不会保存在 Sketch 中。");
  alert.addButtonWithTitle("登录");
  alert.addButtonWithTitle("取消");

  const view = NSView.alloc().initWithFrame(NSMakeRect(0, 0, 360, 150));
  const server = NSTextField.alloc().initWithFrame(NSMakeRect(0, 106, 360, 28));
  server.setPlaceholderString("服务地址，例如 http://服务器IP:8765");
  server.setStringValue(serverURL());
  const username = NSTextField.alloc().initWithFrame(NSMakeRect(0, 62, 360, 28));
  username.setPlaceholderString("账号");
  username.setStringValue(Settings.settingForKey(USER_KEY) || "");
  const password = NSSecureTextField.alloc().initWithFrame(NSMakeRect(0, 22, 360, 28));
  password.setPlaceholderString("密码");
  view.addSubview(server);
  view.addSubview(username);
  view.addSubview(password);
  alert.setAccessoryView(view);

  if (alert.runModal() !== NSAlertFirstButtonReturn) return;
  try {
    const origin = normalizeServerURL(String(server.stringValue()));
    // 重新登录/切换服务时清除旧令牌，不能把另一部署的会话带入新地址。
    Settings.setSettingForKey(SERVER_KEY, origin);
    Settings.setSettingForKey(TOKEN_KEY, undefined);
    const result = request("POST", "/api/plugin/login", {
      username: String(username.stringValue()),
      password: String(password.stringValue()),
    });
    Settings.setSettingForKey(TOKEN_KEY, result.token);
    Settings.setSettingForKey(USER_KEY, String(username.stringValue()));
    callback(result.token, result.user);
  } catch (error) {
    UI.alert("登录失败", error.message);
  }
}

function loginToServer() {
  login(() => UI.message("Design Hub 登录成功"));
}

function logout() {
  Settings.setSettingForKey(TOKEN_KEY, undefined);
  Settings.setSettingForKey(USER_KEY, undefined);
  UI.message("已退出 Design Hub");
}

function withToken(callback) {
  const token = Settings.settingForKey(TOKEN_KEY);
  if (token && serverURL()) {
    try {
      const me = request("GET", "/api/me", null, token);
      callback(token, me.user);
      return;
    } catch (error) {
      if (!/登录|失效|401/.test(error.message)) {
        UI.alert("连接失败", error.message);
        return;
      }
    }
  }
  login(callback);
}

function findArtboard(layer) {
  let current = layer;
  while (current) {
    if (current.type === "Artboard") return current;
    current = current.parent;
  }
  return null;
}

function selectedArtboards() {
  const document = sketch.getSelectedDocument();
  if (!document) return [];
  const unique = new Map();
  document.selectedLayers.layers.forEach((layer) => {
    const artboard = findArtboard(layer);
    if (artboard) unique.set(artboard.id, artboard);
  });
  return [...unique.values()];
}

function choose(title, items, callback) {
  if (!items.length) {
    UI.alert(title, "没有可选择的内容");
    return;
  }
  const labels = items.map((item) => item.label);
  UI.getInputFromUser(title, { type: UI.INPUT_TYPE.selection, possibleValues: labels }, (error, value) => {
    if (error) return;
    callback(items[labels.indexOf(value)].value);
  });
}

function confirmUpload(artboards, projectName, folderName) {
  const alert = NSAlert.alloc().init();
  alert.setMessageText(`上传 ${artboards.length} 个画板`);
  alert.setInformativeText(`${serverURL()}\n${projectName} / ${folderName}\n\n${artboards.map((board) => `• ${board.name}`).join("\n")}`);
  alert.addButtonWithTitle("开始上传");
  alert.addButtonWithTitle("取消");
  return alert.runModal() === NSAlertFirstButtonReturn;
}

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function layerIdentifier(layer) {
  if (layer && layer.id) return String(layer.id);
  try { return String(layer.sketchObject.objectID()); } catch (_) { return ""; }
}

function compactColor(value) {
  if (value === undefined || value === null) return null;
  return String(value);
}

function pointMetadata(point) {
  return point ? { x: number(point.x), y: number(point.y) } : null;
}

function gradientMetadata(gradient) {
  if (!gradient) return null;
  return {
    type: String(gradient.gradientType || gradient.type || ""),
    from: pointMetadata(gradient.from),
    to: pointMetadata(gradient.to),
    stops: (gradient.stops || []).map((stop) => ({ position: number(stop.position), color: compactColor(stop.color) })),
  };
}

function textFontMetadata(layer) {
  try {
    const attributed = layer.sketchObject.attributedStringValue();
    if (!attributed.length()) return {};
    const attributes = attributed.attributesAtIndex_effectiveRange(0, null);
    const font = attributes.objectForKey(NSFontAttributeName);
    return font ? { displayName: String(font.displayName()), postscriptName: String(font.fontName()) } : {};
  } catch (_) {
    return {};
  }
}

function isMaskLayer(layer) {
  try {
    return Boolean(layer.sketchObject.hasClippingMask());
  } catch (_) {
    return false;
  }
}

function styleMetadata(layer) {
  const style = layer.style || {};
  return {
    opacity: style.opacity,
    cornerRadius: style.cornerRadius,
    fills: (style.fills || []).map((fill) => ({
      enabled: fill.enabled,
      fillType: String(fill.fillType || ""),
      color: compactColor(fill.color),
      opacity: fill.opacity,
      blendMode: String(fill.blendingMode || ""),
      gradient: gradientMetadata(fill.gradient),
      pattern: fill.pattern ? { patternType: String(fill.pattern.patternType || ""), tileScale: fill.pattern.tileScale } : null,
    })),
    borders: (style.borders || []).map((border) => ({
      enabled: border.enabled,
      color: compactColor(border.color),
      thickness: border.thickness,
      position: String(border.position || ""),
    })),
    shadows: (style.shadows || []).map((shadow) => ({
      enabled: shadow.enabled,
      color: compactColor(shadow.color),
      x: shadow.x,
      y: shadow.y,
      blur: shadow.blur,
      spread: shadow.spread,
    })),
    blur: style.blur ? { enabled: style.blur.enabled, radius: style.blur.radius, type: String(style.blur.blurType || "") } : null,
  };
}

function layerMetadata(layer) {
  const result = {
    id: layerIdentifier(layer),
    name: String(layer.name || "未命名"),
    type: String(layer.type || "Layer"),
    frame: {
      x: number(layer.frame && layer.frame.x),
      y: number(layer.frame && layer.frame.y),
      width: number(layer.frame && layer.frame.width),
      height: number(layer.frame && layer.frame.height),
    },
    rotation: number(layer.transform && layer.transform.rotation),
    hidden: Boolean(layer.hidden),
    locked: Boolean(layer.locked),
    horizontalSizing: layer.horizontalSizing,
    verticalSizing: layer.verticalSizing,
    horizontalPins: layer.horizontalPins,
    verticalPins: layer.verticalPins,
    clipsContent: layer.clipsContent,
    isMask: isMaskLayer(layer),
    style: styleMetadata(layer),
    exportFormats: (layer.exportFormats || []).map((format) => ({
      fileFormat: String(format.fileFormat || ""),
      size: String(format.size || ""),
      prefix: String(format.prefix || ""),
      suffix: String(format.suffix || ""),
    })),
    layers: (layer.layers || []).map(layerMetadata),
  };
  if (layer.type === "Text") {
    const font = textFontMetadata(layer);
    result.text = {
      content: String(layer.text || ""),
      fontFamily: layer.style && layer.style.fontFamily,
      fontSize: layer.style && layer.style.fontSize,
      fontWeight: layer.style && layer.style.fontWeight,
      fontName: font.displayName,
      fontPostscriptName: font.postscriptName,
      fontStyle: layer.style && layer.style.fontStyle,
      lineHeight: layer.style && layer.style.lineHeight,
      kerning: layer.style && layer.style.kerning,
      paragraphSpacing: layer.style && layer.style.paragraphSpacing,
      alignment: layer.style && String(layer.style.alignment || ""),
      verticalAlignment: layer.style && String(layer.style.verticalAlignment || ""),
      textTransform: layer.style && String(layer.style.textTransform || ""),
      textDecoration: layer.style && String(layer.style.textDecoration || ""),
      color: layer.style && compactColor(layer.style.textColor),
    };
  }
  return result;
}

function createTempDirectory() {
  const directory = String(NSTemporaryDirectory()) + "design-hub-" + String(NSUUID.UUID().UUIDString());
  NSFileManager.defaultManager().createDirectoryAtPath_withIntermediateDirectories_attributes_error(directory, true, null, null);
  return directory;
}

function filesIn(directory) {
  const enumerator = NSFileManager.defaultManager().enumeratorAtPath(directory);
  const files = [];
  let value;
  while ((value = enumerator.nextObject())) files.push(String(value));
  return files;
}

function base64File(path) {
  const data = NSData.dataWithContentsOfFile(path);
  if (!data || !data.length()) throw new Error("导出资源为空或无法读取");
  return String(data.base64EncodedStringWithOptions(0));
}

function exportLayerFiles(layer, directory, kind = "slice", includeSvg = true) {
  const exported = [];
  const identifier = layerIdentifier(layer);
  try {
    sketch.export(layer, { output: directory, formats: "png", scales: "1,2,3", "use-id-for-name": true, overwriting: true });
  } catch (error) {
    throw new Error(`图层“${layer.name}”PNG 导出失败`);
  }
  if (includeSvg) {
    try {
      sketch.export(layer, { output: directory, formats: "svg", scales: "1", "use-id-for-name": true, overwriting: true });
    } catch (_) {}
  }
  filesIn(directory).filter((file) => file.startsWith(identifier)).forEach((file) => {
    const extension = file.split(".").pop().toLowerCase();
    const scaleMatch = file.match(/@(\d+(?:\.\d+)?)x\./);
    exported.push({
      layer_id: identifier,
      name: String(layer.name || "未命名资源"),
      kind,
      format: extension,
      scale: scaleMatch ? Number(scaleMatch[1]) : 1,
      width: number(layer.frame && layer.frame.width) * (scaleMatch ? Number(scaleMatch[1]) : 1),
      height: number(layer.frame && layer.frame.height) * (scaleMatch ? Number(scaleMatch[1]) : 1),
      data_base64: base64File(directory + "/" + file),
    });
  });
  return exported;
}

function enabledShadows(layer, output = []) {
  (layer.style && layer.style.shadows || []).filter((shadow) => shadow.enabled !== false).forEach((shadow) => output.push(shadow));
  (layer.layers || []).forEach((child) => enabledShadows(child, output));
  return output;
}

function exportShadowlessLayerFiles(layer, directory) {
  const shadows = enabledShadows(layer);
  if (!shadows.length) return [];
  const target = directory + "/no-shadow-" + layerIdentifier(layer);
  NSFileManager.defaultManager().createDirectoryAtPath_withIntermediateDirectories_attributes_error(target, true, null, null);
  try {
    shadows.forEach((shadow) => { shadow.enabled = false; });
    return exportLayerFiles(layer, target, "slice-no-shadow", false);
  } finally {
    shadows.forEach((shadow) => { shadow.enabled = true; });
  }
}

function collectAssetLayers(layer, output = []) {
  const style = layer.style || {};
  const hasPattern = (style.fills || []).some((fill) => String(fill.fillType || "") === "Pattern");
  const autoExport = ["Bitmap", "Image", "SymbolInstance", "Shape", "ShapePath", "Text", "Group"].includes(String(layer.type || ""));
  if ((layer.exportFormats || []).length || hasPattern || autoExport) {
    output.push(layer);
  }
  (layer.layers || []).forEach((child) => collectAssetLayers(child, output));
  return output;
}

function exportPreview(artboard, directory) {
  sketch.export(artboard, { output: directory, formats: "png", scales: "2", "use-id-for-name": true, overwriting: true });
  const previewFile = filesIn(directory).find((file) => file.startsWith(layerIdentifier(artboard)) && file.endsWith(".png"));
  if (!previewFile) throw new Error(`无法导出画板“${artboard.name}”的预览图`);
  return base64File(directory + "/" + previewFile);
}

function buildPayload(artboard, folderId) {
  const directory = createTempDirectory();
  try {
    const artboardDirectory = directory + "/" + layerIdentifier(artboard);
    NSFileManager.defaultManager().createDirectoryAtPath_withIntermediateDirectories_attributes_error(artboardDirectory, true, null, null);
    return { folder_id: folderId, artboards: [{
      sketch_id: layerIdentifier(artboard),
      name: String(artboard.name),
      width: number(artboard.frame.width),
      height: number(artboard.frame.height),
      canvas_x: number(artboard.frame.x),
      canvas_y: number(artboard.frame.y),
      metadata: { artboard: layerMetadata(artboard) },
      preview_base64: exportPreview(artboard, artboardDirectory),
    }] };
  } finally {
    NSFileManager.defaultManager().removeItemAtPath_error(directory, null);
  }
}

function uploadProgress(total) {
  const window = NSWindow.alloc().initWithContentRect_styleMask_backing_defer(NSMakeRect(0, 0, 440, 132), NSTitledWindowMask, NSBackingStoreBuffered, false);
  // Mocha 管理原生对象的生命周期；close 不得再额外释放窗口。
  window.setReleasedWhenClosed(false);
  window.setTitle("正在上传到 Design Hub");
  const current = NSTextField.alloc().initWithFrame(NSMakeRect(20, 82, 400, 24));
  current.setEditable(false); current.setBezeled(false); current.setDrawsBackground(false); current.setFont(NSFont.boldSystemFontOfSize(13));
  const indicator = NSProgressIndicator.alloc().initWithFrame(NSMakeRect(20, 56, 400, 14));
  indicator.setIndeterminate(false); indicator.setMinValue(0); indicator.setMaxValue(100); indicator.setDoubleValue(0);
  const summary = NSTextField.alloc().initWithFrame(NSMakeRect(20, 22, 400, 22));
  summary.setEditable(false); summary.setBezeled(false); summary.setDrawsBackground(false); summary.setTextColor(NSColor.secondaryLabelColor());
  window.contentView().addSubview(current); window.contentView().addSubview(indicator); window.contentView().addSubview(summary); window.center(); window.makeKeyAndOrderFront(null);
  const refresh = () => {
    // 每个画板由官方定时器分帧执行；这里只刷新控件，不手动嵌套 RunLoop。
    window.displayIfNeeded();
  };
  return {
    update(completed, phase, artboard, counts, active) {
      const progress = Math.round((completed / total) * 100);
      current.setStringValue(`${phase} · ${artboard.name}`);
      indicator.setDoubleValue(progress);
      summary.setStringValue(`完成 ${completed}/${total} · 上传中 ${active}/${Math.min(UPLOAD_CONCURRENCY, total)} · 新增 ${counts.created || 0} · 更新 ${counts.updated || 0} · 未变化 ${counts.unchanged || 0} · 失败 ${counts.failed || 0}`);
      UI.message(`上传进度 ${progress}% · 完成 ${completed}/${total} · ${artboard.name}`); refresh();
    },
    finish(counts) {
      indicator.setDoubleValue(100); current.setStringValue(`已处理 ${total}/${total} 个画板`); summary.setStringValue(`新增 ${counts.created || 0} · 更新 ${counts.updated || 0} · 未变化 ${counts.unchanged || 0} · 失败 ${counts.failed || 0}`); refresh();
    },
    close() { window.orderOut(null); window.close(); },
  };
}

function uploadToFolder(token, project, folder, artboards) {
  // 在同步选项回调内固定基础值，后续 fiber 不再读取弹窗回调持有的目标对象。
  const projectId = String(project && project.id || "");
  const folderId = String(folder && folder.id || "");
  const sessionToken = String(token || "");
  const base = `/api/projects/${projectId}/uploads`;
  if (!/^[0-9a-f-]{36}$/i.test(projectId) || !/^[0-9a-f-]{36}$/i.test(folderId) || !sessionToken) {
    UI.alert("无法开始上传", "项目、目录或登录状态无效，请重新选择后上传。");
    return;
  }
  // 在途批次固定目标地址，即使另一次操作修改设置，也不能把令牌发到另一服务器。
  const uploadOrigin = normalizeServerURL(serverURL());
  if (!confirmUpload(artboards, project.name, folder.name)) return;
  const counts = { created: 0, updated: 0, unchanged: 0, failed: 0 }; const failures = []; const progress = uploadProgress(artboards.length);
  const fail = (artboard, error) => { counts.failed += 1; failures.push(`${artboard.name}：${error.message}`); console.log(`[DesignHub]:[Upload] 失败 artboard=${artboard.name} error=${error.message}`); };
  let index = 0;
  const uploadNext = () => {
    const artboard = artboards[index];
    progress.update(index, "正在导出", artboard, counts, 0);
    let uploadId = null; let layerIndex = 0; let chunks = 0; let assets = 0; let layers = [];
    const advance = () => {
      index += 1; progress.update(index, "已完成", artboard, counts, 0);
      if (index < artboards.length) { schedule(uploadNext); return; }
      progress.finish(counts); progress.close(); UI.message("上传进度 100% · 完成");
      const failureText = failures.length ? `\n\n失败画板：\n${failures.slice(0, 8).join("\n")}${failures.length > 8 ? `\n另有 ${failures.length - 8} 个失败` : ""}` : "";
      UI.alert(failures.length ? "上传完成（部分失败）" : "上传完成", `分批上传 · 新增 ${counts.created} · 更新 ${counts.updated} · 未变化 ${counts.unchanged} · 失败 ${counts.failed}${failureText}`);
    };
    const abort = (error) => {
      fail(artboard, error);
      if (uploadId) { try { request("POST", `${base}/${uploadId}/cancel`, {}, sessionToken, uploadOrigin); } catch (_) { /* 断网暂存由服务端过期清理。 */ } }
      advance();
    };
    const uploadLayer = () => {
      try {
        if (layerIndex < layers.length) {
          const directory = createTempDirectory();
          try {
            const layer = layers[layerIndex];
            const batch = exportLayerFiles(layer, directory).concat(exportShadowlessLayerFiles(layer, directory));
            if (!batch.length) throw new Error(`图层“${layer.name}”未导出任何资源`);
            // 单个资源一批，避免父分组的多倍率 PNG 同时进入一个请求。
            for (const asset of batch) {
              const ack = request("POST", `${base}/${uploadId}/chunk`, { index: chunks, assets: [asset] }, sessionToken, uploadOrigin);
              if (ack.index !== chunks || ack.received !== 1) throw new Error("服务端未确认资源批次");
              chunks += 1; assets += 1;
            }
          } finally { NSFileManager.defaultManager().removeItemAtPath_error(directory, null); }
          layerIndex += 1;
          progress.update(index, `资源 ${assets} 个已上传 · 图层 ${layerIndex}/${layers.length}`, artboard, counts, 1);
          schedule(uploadLayer); return;
        }
        const result = request("POST", `${base}/${uploadId}/commit`, { chunks, assets }, sessionToken, uploadOrigin);
        const item = result.results && result.results[0];
        if (!item || result.results.length !== 1 || item.sketch_id !== layerIdentifier(artboard) || !["created", "updated", "unchanged"].includes(item.status)) {
          throw new Error("服务端未确认当前画板上传结果，请检查网页后重试");
        }
        counts[item.status] += 1;
        advance();
      } catch (error) { abort(error); }
    };
    try {
      const payload = buildPayload(artboard, folderId);
      layers = collectAssetLayers(artboard);
      const started = request("POST", base, { folder_id: folderId, board: payload.artboards[0] }, sessionToken, uploadOrigin);
      uploadId = started.upload_id;
      if (!/^[0-9a-f-]{36}$/.test(uploadId || "")) throw new Error("服务端没有返回有效上传任务，请升级服务端");
      schedule(uploadLayer);
    } catch (error) { abort(error); }
  };
  schedule(uploadNext);
}

function chooseOrCreateFolder(token, project, folders, artboards) {
  const items = [{ label: "＋ 新建目录…", value: { create: true } }].concat(folders.map((folder) => ({ label: folder.name, value: folder })));
  choose("选择目标目录", items, (folder) => {
    if (!folder.create) return uploadToFolder(token, project, folder, artboards);
    UI.getInputFromUser("新建目录", { initialValue: "" }, (error, name) => {
      if (error) return;
      const folderName = String(name || "").trim();
      if (!folderName) { UI.alert("无法新建目录", "目录名称不能为空"); return; }
      try {
        const created = request("POST", `/api/projects/${project.id}/folders`, { name: folderName }, token);
        uploadToFolder(token, project, { id: created.id, name: folderName }, artboards);
      } catch (createError) {
        UI.alert("新建目录失败", createError.message);
      }
    });
  });
}

function uploadSelectedArtboards() {
  console.log("[DesignHub]:[Upload] 开始读取选区");
  const artboards = selectedArtboards();
  console.log(`[DesignHub]:[Upload] 选中画板数量=${artboards.length}`);
  if (!artboards.length) {
    UI.alert("没有选择画板", "请先在 Sketch 画布中选择一个或多个 Artboard，再运行上传。");
    return;
  }
  chooseUploadServer(() => withToken((token, user) => {
    if (!["designer", "admin"].includes(user.role)) {
      UI.alert("没有上传权限", "当前账号不是设计人员或管理员。");
      return;
    }
    try {
      const projectResult = request("GET", "/api/projects", null, token);
      const projects = projectResult.projects.filter((project) => ["editor", "owner", "admin"].includes(project.access_role));
      choose("选择目标项目", projects.map((project) => ({ label: `${project.name} · ${project.access_role}`, value: project })), (project) => {
        try {
          const folderResult = request("GET", `/api/projects/${project.id}/folders`, null, token);
          chooseOrCreateFolder(token, project, folderResult.folders, artboards);
        } catch (error) {
          UI.alert("读取目录失败", error.message);
        }
      });
    } catch (error) {
      UI.alert("读取项目失败", error.message);
    }
  }));
}
