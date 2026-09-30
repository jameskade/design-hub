# Design Hub

**把 Sketch 设计稿、版本、标注与资源，交到团队和 AI 手中。**

Design Hub 是可自部署的设计交付工具：设计师从 Sketch 同步选中的画板，开发者在浏览器中查看标注和导出资源，AI 通过 MCP 读取结构化设计上下文。数据保存在你部署的服务中。

它用于减少反复传设计文件、找错版本、询问尺寸和索取切图的沟通；也让 AI 除了图片，还能读取图层、坐标、文字、样式和可下载资源。

> 当前适合可信局域网中的小团队。完整部署和 JPG 转换目前依赖 macOS；尚未提供 Docker 镜像，也没有内置公网 HTTPS。

## 已支持的功能

| 范围 | 功能 |
| --- | --- |
| Sketch 交付 | 选中画板上传、项目与目录选择、实际上传进度；新画板新增，同一画板变更生成版本，未变化跳过，未选画板不受影响 |
| 团队工作台 | 项目与设计稿搜索、画布平移缩放、历史版本查看、响应式布局 |
| 单图标注 | 图层尺寸、文字和样式、矩形边界间距、双击复制属性值 |
| 资源导出 | PNG/JPG/SVG（以已上传资源为准）、1x/2x/3x、iOS/Android/Flutter 命名；有真实无阴影资源时支持去阴影 |
| 账号与协作 | 注册审核、系统身份与项目角色、成员管理、回收站、服务端审计记录 |
| AI 接入 | 用户绑定的只读 API Key、结构化画板上下文、图片读取、三个本地 stdio MCP 工具 |
| 网页接入中心 | 插件与 MCP 脚本下载、客户端配置生成、个人 Key 管理、简体中文指南和快捷键 |

间距基于设计元数据中的矩形边界，不是对不透明像素轮廓测距。资源按真实图层、Group/Symbol 层级导出，不按视觉邻近自动拼组。

## 谁需要安装什么

| 角色 | 安装位置 | 开始使用 |
| --- | --- | --- |
| 管理员 | 一台常驻的 Mac | 部署服务、审核账号、维护数据 |
| 设计师 | 自己的 Mac / Sketch | 从已部署网站下载插件，登录并同步画板 |
| 开发者 | 浏览器 | 获得项目查看权限后查看标注、复制属性、导出资源 |
| AI 使用者 | 运行 AI 客户端的电脑 | 下载 MCP 脚本，配置本机 Python 和路径，使用自己的只读 Key |

普通团队成员不必克隆仓库。管理员部署后，把可访问的网站地址发给同事即可。

## macOS 快速部署

需要 Python 3.9+、macOS 自带的 launchd、curl、lsof；JPG 转换使用系统 sips。服务与 MCP 使用 Python 标准库，网页不需要 Node 构建。Sketch 只需要安装在设计师的电脑上。

下载源码并进入仓库目录后运行：

```bash
./gh_design_hub prepare
./gh_design_hub start
./gh_design_hub credentials
```

`prepare` 在本机创建 `.env` 并生成初始管理员密码；`start` 使用当前 macOS 用户的 launchd 后台运行服务。`credentials` 在本机显示初始登录信息，不要把输出发到公开日志。

浏览器打开 `http://127.0.0.1:8765`。给其他电脑访问时使用服务器的局域网 IP 或域名，例如 `http://服务器局域网IP:8765`。`0.0.0.0` 是监听地址，不能作为访问地址；`127.0.0.1` 只指向当前电脑。

登录管理员账号后，在「人员管理」给新账号分配身份，再由项目负责人添加成员。新注册账号默认待审核，没有项目访问权限。

默认端口 `8765`，单次请求上传限制 `150MB`。可在首次启动前复制 `.env.example` 为 `.env` 调整配置，或使用控制命令生成的 `.env`。不要在已有部署上覆盖该文件。全局命令安装是可选的：

```bash
./install_global_design_hub.sh
gh_design_hub status
```

全局安装要求 `~/.local/bin` 已在 PATH。若无需全局命令，始终使用仓库内的 `./gh_design_hub` 即可。launchd 当前运行于用户登录会话，无人值守使用前应确认该 Mac 的登录与电源策略。

## 部署后，从网页完成接入

网站顶部提供「Sketch 插件」「MCP 接入」；登录页和待审核页也能访问说明与安装下载。

| 地址（拼接在你的网站地址后） | 用途 |
| --- | --- |
| `/connect/sketch` | 下载插件、复制当前服务地址、安装与首次上传说明 |
| `/connect/mcp` | 下载脚本、生成客户端配置、管理个人 Key、实际调用验证步骤 |
| `/connect/guide` | 角色入门、权限说明、快捷键与常见问题 |

Sketch 使用流程：下载 ZIP → 解压并双击 `DesignHub.sketchplugin` → 在 Sketch 中配置服务地址 → 选中画板 → 上传并选择项目与目录。安装包版本读取仓库内 manifest，网页下载与当前部署配套。管理员也可在自己的 Mac 运行 `./install_sketch_plugin.sh` 安装。

两个公开下载地址只提供应用安装文件，不包含账号、数据库、设计稿和 Key：

```text
/downloads/DesignHub.sketchplugin.zip
/downloads/design_hub_mcp.py
```

## MCP 接入

当前实现是**本地 stdio MCP**，不是网站上的远程 `/mcp` 端点。脚本由 AI 客户端在本机启动，通过 HTTP(S) 连接 Design Hub。提供 Python 3 即可，不需要第三方 Python 包。

在网页 `/connect/mcp` 下载脚本后，填写它在运行 AI 客户端的电脑上的绝对路径，生成 Codex TOML 或接受 `mcpServers` 的客户端 JSON 配置。不要把服务器路径填入另一台电脑的配置。

Codex 示例（替换为自己的路径，并合并到已有配置，保留其他设置）：

```toml
[mcp_servers.design-hub]
command = "python3"
args = ["/absolute/path/design_hub_mcp.py"]
```

默认配置文件为 `~/.codex/config.toml`。如果客户端无法从 PATH 找到 Python，`command` 填本机解释器的绝对路径。Windows 用户通常使用 `python` 或 Python 可执行文件路径。保存后重新加载 MCP 或重新打开客户端；Codex CLI 可用 `codex mcp list` 查看配置。参见 [Codex 官方 MCP 文档](https://developers.openai.com/codex/mcp)。

| 工具 | 必需参数 | 返回 |
| --- | --- | --- |
| `design_hub_list_projects` | `base_url`、`api_key` | 当前 Key 有权限查看的项目 |
| `design_hub_get_artboard_context` | 上述参数，加 `artboard` | 画板、版本、图层、文字、样式、坐标与资源；`artboard` 支持完整网页链接 |
| `design_hub_get_asset` | 上述连接参数，加 `asset_id` | 图片资源内容 |

Key 在网页 MCP 页登录后创建，绑定当前用户并实时继承项目权限；完整值只在创建时显示一次，服务端只保存哈希。脚本按每次调用接收服务地址和 Key，配置示例不保存 Key。在自己的 AI 客户端提供凭据，不把密钥放到共享文档、下载地址或页面 URL。

**配置完成不等于接入成功。** 请让 AI 实际执行「列项目 → 读一张有权限画板 → 读取其中一个 PNG」，以工具返回结果为准。网站无法探测另一台电脑上 AI 客户端的 MCP 连接状态。

## 操作与维护

```bash
./gh_design_hub status
./gh_design_hub stop
./gh_design_hub restart
./gh_design_hub logs
```

状态面板可能显示初始管理员密码，转发输出前先检查内容。网页重置管理员密码后，以网页中的新密码为准，`.env` 中的初始密码不会自动跟随变更。

数据默认在 `data/`：SQLite 为 `data/design-hub.sqlite3`，设计稿和资源在 `data/projects/`。`.env`、`data/`、`logs/` 均被 Git 忽略。备份需同时包含数据库与资源；停服务后可整体复制 `data/`，不停服务时需使用 SQLite backup API，并保证数据库与资源备份的一致性。

升级前先备份。保留 `.env` 与数据目录，更新应用代码并重启；有插件更新时，让设计师从同一服务重新下载。尚未提供自动升级、跨版本数据回滚或多节点部署保证。

只读接口发现入口：`/openapi.json`、`/llms.txt`、`/docs`、`/.well-known/design-hub.json`；单稿自描述入口 `/ai/artboards/{id}` 公开接口位置和认证方式，但不公开设计内容。

## 当前边界

- 完整原生服务链路目前面向 macOS。Linux/Docker 要先适配启动方式与 JPG 转换；目前没有可直接使用的 Docker 镜像或 Compose 部署。
- 面向可信局域网，不应把当前标准库 HTTP 服务直接暴露公网。公网使用需另行配置 HTTPS、访问控制、限流及安全验收。
- 尚无批注协作、实时多人编辑、视觉版本差异或 Figma 导入。
- macOS/Sketch、AI 客户端和浏览器兼容性需要在实际环境确认；不同客户端不一定使用相同 JSON 配置格式。
- 开源许可证尚未确定。公开前应确认代码和展示素材的发布权属，并添加明确许可证；内部验收截图不应直接作为公开宣传素材。

## 开发验证

前端纯逻辑检查：`node server/test_frontend.cjs`。接入与下载检查：`python3 server/test_integrations.py`，使用独立临时数据和端口，不访问正式业务数据库。

已有 `server/test_smoke.py` 会注册账号并写入验收数据，只应运行在专用隔离服务上，不要对正式地址执行。
