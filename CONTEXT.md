# Design Hub Domain Language

Design Hub 接收设计师选中的 Sketch 画板，并把它们转换为团队可查看、标注和导出的设计稿。以下词汇是产品、界面、插件、API 文档和操作记录的统一语言。

## 身份与权限

**用户（User）**:
能够登录 Design Hub 的人员。用户具有一个系统身份，并可通过项目成员关系获得项目权限。

**系统角色（System role）**:
决定用户在系统层面的能力：`pending`、`developer`、`designer`、`admin` 或 `disabled`。

**项目成员关系（Project membership）**:
用户与项目之间的授权关系，角色为 `viewer`、`editor` 或 `owner`。

## 设计结构

**项目（Project）**:
设计协作的最高层容器。只有 Admin 和获得项目成员关系的用户能够访问。

**目录（Directory）**:
项目内用于组织设计稿的容器，继承项目权限，不单独授权。
_Avoid_: 分组、Folder（用户界面）

**Sketch 文档（Sketch document）**:
设计师电脑中的完整 `.sketch` 文件，可以包含多个 Page、画板和未选择内容。
_Avoid_: 设计稿、源稿快照

**Sketch 画板（Sketch artboard）**:
Sketch 文档中具有稳定 ID 的画板对象，是设计师在插件中选择的上传单位。
_Avoid_: 设计稿（Sketch 界面）

**设计稿（Design）**:
一个 Sketch 画板同步到 Design Hub 后形成的业务对象，通过 Sketch 画板稳定 ID 持续更新。
_Avoid_: 元素、稿件、页面、Artboard（用户界面）

**当前版本（Current design version）**:
一张设计稿现在对外展示和使用的唯一内容版本。设计稿更新成功后，新版本取代旧版本成为当前版本。
_Avoid_: 目录版本、最终版本、上传任务

**目录当前状态（Directory current state）**:
目录内所有未删除设计稿的当前版本集合。目录本身没有版本。
_Avoid_: 目录版本、目录最终版本

**图层（Layer）**:
设计稿内部的文字、编组、形状、位图等结构，保留其真实父子关系。
_Avoid_: 元素

## 交付内容

**解析结果（Design context）**:
从源稿快照提取的结构化设计数据，供网页标注、图层查看、测距、MCP 和 AI 使用。
_Avoid_: Sketch 源文件、原始 JSON

**预览图（Preview）**:
用于在网页画布中展示整张设计稿的图片。
_Avoid_: 切图、源稿

**切图资源（Export asset）**:
从具体图层导出的 PNG、SVG、不同倍率或无阴影文件。
_Avoid_: 预览图、源稿快照、资源文件（需要明确类型时）

**源稿快照（Source snapshot）**:
一张设计稿及其必要 Symbol、图片、字体和样式依赖组成的自包含源文件，可以重建为 Sketch 打开的 `.sketch`。一张设计稿只对应一份当前源稿快照。
_Avoid_: 完整原稿、多设计稿上传包、任务临时文件

## 同步与记录

**上传选区（Upload selection）**:
设计师在 Sketch 插件中确认的画板集合。未选画板在该次上传中不发生任何变化。

**选区上传包（Selection upload package）**:
为提高传输效率，把本次上传选区临时装入同一个 `.sketch` 的传输容器。服务器接收后将其拆成每张设计稿独立的源稿快照，发布完成后删除上传包。
_Avoid_: 设计稿源文件、长期源稿

**上传任务（Upload job）**:
一次上传、解析和发布过程的执行记录。上传任务不是设计稿版本，任务临时文件可以在完成后清理。
_Avoid_: 版本、设计稿、源稿快照

**上传设计稿（Upload design）**:
某个 Sketch 画板首次在项目中形成设计稿。

**更新设计稿（Update design）**:
已存在的设计稿接收到变化内容，并用新内容替换当前版本。

**操作记录（Activity record）**:
面向人的业务变更与安全记录总称，分为业务操作、权限与安全、访问摘要。记录使用完整业务语句，不直接展示内部对象类型、UUID 或“元素”。

**业务操作（Business activity）**:
成功改变项目内容或状态的操作，每次单独记录。设计稿记录使用“操作人 + 上传了或更新了 + 项目 + 目录 + 设计稿名称”的完整语句。

**权限与安全记录（Security activity）**:
账号身份、项目成员、权限、API Key、永久删除等安全相关变化，每次单独记录。

**访问摘要（Access summary）**:
对频繁只读访问的聚合说明，记录谁通过什么方式访问了哪个项目以及累计次数，不为每个 MCP 调用、预览加载或普通读取生成单独记录。

**技术日志（Technical log）**:
用于服务排障的请求、错误、性能和后台任务信息，不属于用户操作记录，不在普通操作历史中展示。

**回收站（Recycle bin）**:
软删除内容的恢复区。永久删除仅允许 Admin 执行。
