const sketch = require("sketch");
const UI = require("sketch/ui");
const Settings = require("sketch/settings");

const SERVER_KEY = "designHub.serverURL";
const TOKEN_KEY = "designHub.sessionToken";
const USER_KEY = "designHub.username";
// 下载打包时由对应部署注入地址；直接安装源码时必须手动填写。
const BUNDLED_SERVER_URL = "";
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

function isLayerVisible(layer) {
  // 子层自身可见并不代表实际可见，隐藏父层必须阻断整条分支。
  let current = layer;
  while (current) {
    if (current.hidden) return false;
    current = current.parent;
  }
  return Boolean(layer);
}

function findArtboard(layer) {
  if (!isLayerVisible(layer)) return null;
  let current = layer;
  let artboard = null;
  while (current) {
    // 嵌套画框属于外层界面，不能因选中内部内容而创建独立界面。
    if (current.type === "Artboard") artboard = current;
    current = current.parent;
  }
  return artboard;
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

function confirmProcessingMode(artboards, projectName, folderName, origin) {
  const alert = NSAlert.alloc().init();
  alert.setMessageText(`上传 ${artboards.length} 个画板`);
  alert.setInformativeText(`${origin}\n${projectName} / ${folderName}\n\n请选择处理方式。服务器处理上传快照；本地处理导出资源后后台并行上传。`);
  const mode = NSPopUpButton.alloc().initWithFrame_pullsDown(NSMakeRect(0,0,340,30),false);
  mode.addItemsWithTitles(["服务器处理（推荐）", "本地处理（后台并行上传）"]);
  alert.setAccessoryView(mode);alert.addButtonWithTitle("开始上传");alert.addButtonWithTitle("取消");
  if(alert.runModal()!==NSAlertFirstButtonReturn)return null;
  return Number(mode.indexOfSelectedItem())===0 ? "server" : "local";
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

function hasVisibleText(layer) {
  if (layer.hidden || (layer.style && layer.style.opacity === 0)) return false;
  return layer.type === "Text" || (layer.layers || []).some(hasVisibleText);
}

function isAtomicLayer(layer) {
  // 可整体导出的卡片仍需保留文字标注，不能仅凭导出格式折叠布局。
  return layer.type === "Shape" || ((layer.exportFormats || []).length > 0 && !hasVisibleText(layer));
}

function hasVisibleContent(layer) {
  if (!isLayerVisible(layer)) return false;
  if (layer.type !== "Group") return true;
  const style = layer.style || {};
  return ["fills", "borders", "shadows"].some((key) => (style[key] || []).some((effect) => effect.enabled !== false))
    || (layer.layers || []).some(hasVisibleContent);
}

function layerMetadata(layer, isRoot = false) {
  if (!isLayerVisible(layer)) return null;
  if (!isRoot && !hasVisibleContent(layer) && !isMaskLayer(layer)) return null;
  const atomic = !isRoot && isAtomicLayer(layer);
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
    // 整体切图和布尔形状是交付边界，内部路径不能继续变成独立标注。
    layers: atomic ? [] : (layer.layers || []).map((child) => layerMetadata(child)).filter(Boolean),
    hasDescendantShadows: atomic && enabledShadows(layer).length > 0,
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
  if (!isLayerVisible(layer)) throw new Error(`图层“${layer.name}”已隐藏，已停止当前画板上传`);
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
  if (!isLayerVisible(layer)) return output;
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

function collectAssetLayers(layer, output = [], isRoot = true) {
  if (!hasVisibleContent(layer)) return output;
  const style = layer.style || {};
  const explicitExport = (layer.exportFormats || []).length > 0;
  const hasPattern = (style.fills || []).some((fill) => String(fill.fillType || "") === "Pattern");
  const autoExport = ["Bitmap", "Image", "SymbolInstance", "Shape", "ShapePath", "Text", "Group"].includes(String(layer.type || ""));
  if (explicitExport || hasPattern || autoExport) {
    output.push(layer);
  }
  // 标注和资源使用同一边界，防止布尔形状内部路径被拆成独立资源。
  if (!isRoot && isAtomicLayer(layer)) return output;
  (layer.layers || []).forEach((child) => collectAssetLayers(child, output, false));
  return output;
}

function exportPreview(artboard, directory) {
  sketch.export(artboard, { output: directory, formats: "png", scales: "2", "use-id-for-name": true, overwriting: true });
  const previewFile = filesIn(directory).find((file) => file.startsWith(layerIdentifier(artboard)) && file.endsWith(".png"));
  if (!previewFile) throw new Error(`无法导出画板“${artboard.name}”的预览图`);
  return base64File(directory + "/" + previewFile);
}

function buildPayload(artboard, folderId) {
  if (!isLayerVisible(artboard)) throw new Error("画板已隐藏，已停止上传");
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
      metadata: { artboard: layerMetadata(artboard, true) },
      preview_base64: exportPreview(artboard, artboardDirectory),
    }] };
  } finally {
    NSFileManager.defaultManager().removeItemAtPath_error(directory, null);
  }
}

function uploadWithProcessingMode(token, project, folder, artboards) {
  const origin=normalizeServerURL(serverURL());
  const projectId=String(project.id || ""),folderId=String(folder.id || ""),sessionToken=String(token || "");
  if(!/^[0-9a-f-]{36}$/i.test(projectId)||!/^[0-9a-f-]{36}$/i.test(folderId)||!sessionToken){UI.alert("无法上传","项目、目录或登录状态无效");return;}
  const mode=confirmProcessingMode(artboards,project.name,folder.name,origin);
  if(!mode)return;
  const capabilities=request("GET","/api/me",null,sessionToken,origin);
  const options={token:sessionToken,origin,projectId,folderId,artboards};
  if(mode==="local") {
    if(capabilities.parallel_upload_enabled!==true){UI.alert("服务器需要更新","当前服务不支持并行批次，请先更新服务后再使用本地处理。");return;}
    require("./local-upload")({...options,buildPayload,collectLayers:collectAssetLayers,exportLayer:(layer,directory)=>exportLayerFiles(layer,directory).concat(exportShadowlessLayerFiles(layer,directory))});
    return;
  }
  if(capabilities.snapshot_upload_enabled!==true){UI.alert("服务器处理未启用","当前服务器未启用快照渲染，请启用后重试，或重新选择本地处理。");return;}
  require("./snapshot")( {...options,
    metadata: layerMetadata,
    resources: (board) => collectAssetLayers(board).map((layer) => ({layer_id: layerIdentifier(layer), name: String(layer.name), width: number(layer.frame.width), height: number(layer.frame.height), has_shadow: enabledShadows(layer).length > 0})),
    confirm: () => true} );
}

function chooseOrCreateFolder(token, project, folders, artboards, uploader = uploadWithProcessingMode) {
  const items = [{ label: "＋ 新建目录…", value: { create: true } }].concat(folders.map((folder) => ({ label: folder.name, value: folder })));
  choose("选择目标目录", items, (folder) => {
    if (!folder.create) return uploader(token, project, folder, artboards);
    UI.getInputFromUser("新建目录", { initialValue: "" }, (error, name) => {
      if (error) return;
      const folderName = String(name || "").trim();
      if (!folderName) { UI.alert("无法新建目录", "目录名称不能为空"); return; }
      try {
        const created = request("POST", `/api/projects/${project.id}/folders`, { name: folderName }, token);
        uploader(token, project, { id: created.id, name: folderName }, artboards);
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
    UI.alert("没有选择可见画板", "请先在 Sketch 画布中选择一个或多个可见 Artboard；隐藏图层及隐藏父层中的内容不会上传。");
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
