# DeepSeek Desktop 桌面端

[English](README.md) | 中文

桌面应用在一个原生窗口内提供相互独立的 Chat 与 Harness 模式。窗口关闭后，系统托盘继续持有两种模式的应用生命周期。

## 开发

本节命令需要 Node.js `^22.19.0` 或 `>=24.0.0` 与 pnpm `11.7.0`，仅适用于源码开发与打包。打包应用不要求 Node.js、npm、pnpm、Homebrew 或全局 `dsh`：它自带 Electron 运行时与固定版本 npm 运行时，并通过 Managed Runtime 安装官方 Harness。

安装依赖后，使用单一桌面开发命令。该命令会先构建 Host 与客户端包、Web 前端和 Electron main 进程，再启动应用：

```sh
pnpm run dev:desktop
```

关闭窗口会隐藏窗口。通过托盘菜单恢复窗口或退出应用。显式退出会等待 Host 进程停止，并在 Host 的有界宽限期结束后升级终止行为。

桌面应用只接受 `dsh web` 为 `127.0.0.1` 或 `localhost` 输出的就绪 URL。页面导航限制在该来源；HTTP 和 HTTPS 链接交给系统浏览器打开。

运行无密钥 Electron 场景前需先构建 Desktop 产物。该场景使用本地 Harness 与 Chat 服务器，绝不会访问在线 DeepSeek 网站：

```sh
pnpm --filter @deepseek-ai/dsh-desktop run build
pnpm --filter @deepseek-ai/dsh-desktop run test:electron
```

## 模式与数据

全新安装默认选择 Harness。后续启动会恢复用户通过本地标题栏切换器选择的上一个模式。两个模式的内容视图都从已有 44px 操作系统标题栏下方开始，因此官方 Harness Header、交通灯和切换器不会占用同一组像素。内容视图会填满剩余高度，并在每次窗口调整大小时使用同一组边界重新计算。关闭状态本地 chrome 只紧密包围分段切换器与可选 Chat 操作控件。只有主进程扩展这些边界并确认已应用布局后，Chat 操作菜单或确认对话框才会显示。Harness 独立启动，Chat 只在首次选择后创建；切换模式会保留两个健康视图，而不会重新加载它们。

chrome 视图保持透明。164px 分段切换器渲染等宽的 `Chat` 与 `Harness` 选项；点击任一分段都会直接选择对应模式，不存在模式菜单、箭头、产品图标、外框或紧凑缩写。Desktop 自身的主题入口作用于 Desktop shell 与 Chat：Chat 跟随 `light`／`dark`／`system` 偏好；Desktop 也会在 Chat 隐藏时应用该偏好，并仅在存储值改变时重新加载 Chat。官方 Harness WebUI 保留 Harness 内部的 `light`／`dark`／`system` 设置，不能可靠跟随 Desktop 的主题入口。这是开发阶段已确认并接受的架构边界，而非功能遗漏：当前没有可稳定依赖的官方主题控制接口，强行统一将意味着依赖 Harness 内部状态、注入 DOM 或 fork 官方前端，与本项目不 fork 官方 Harness 前端、降低上游耦合的原则冲突。若未来官方 Harness 提供稳定的外部主题控制接口，可再评估统一主题入口。本地控件通过 Electron 解析 `system`，在亮色内容上显示深色文字，在暗色内容上显示浅色文字。隔离 Chat preload 还只会上报规范化的不透明计算背景色；已有标题栏底色使用该颜色并保留配色后备，未支持的 CSS 值会被拒绝，Chat 菜单和对话框继续使用不透明主题表面。

Harness 保留现有会话、工作区、agent（智能体）配置和回环 Host。Chat 显示 `https://chat.deepseek.com/` 上的官方网站，不会成为 Harness 模型提供方。一个启用沙箱且上下文隔离的 preload 会访问两个经过校验的官方零版本存储项：它同步 `__appKit_@deepseek/chat_themePreference`，并在每个 Chat document 初始化前，只把保留的 `__appKit_@deepseek/chat_lastSessionValue.value.siderCollapsed` 从 `true` 改为 `false`。因此，Chat 创建或重新加载后会以展开侧栏启动；如果用户随后收起侧栏，保留的 Chat 视图会在模式切换期间维持该状态。缺失或未知的侧栏存储不会被修改，同一存储项中的其他页面设置会被保留，preload 也不会向主世界暴露 API 或注入 DOM 控件。Desktop 不会读取 Chat Cookie、凭据、对话、网络响应或网站的其他存储。遇到未知主题存储版本时，主题同步会停用，但 Chat 仍保持可用。

Chat 使用专用的 Electron 持久分区 `persist:dsh-deepseek-chat`。Chromium 会在应用多次启动之间保留该分区，包括在线网站接受的登录状态。Chat 与 Harness 不共享 Cookie、存储、提示词、附件、对话、凭据或导航状态。

**清除 Chat 数据**需要确认；该操作会关闭 Chat 视图及其认证窗口，清除该分区的本地存储与缓存，并在 Chat 被选中时重新创建它。当嵌入网站的认证依赖这些本地数据时，此操作会退出登录并删除本地 Memory，但不会删除 DeepSeek 服务器保存的对话或账户数据。如需保留本地记录，请先导出 Memory JSON。用户也可以通过网站本身退出嵌入登录。

### Chat Memory

Desktop 会把随包提供的 DeepSeek++ Memory-only 衍生版本加载到同一个持久 Chat 分区。固定扩展 ID 使 `DeepSeekPP` IndexedDB 来源在应用重新打包或移动后保持稳定。新 DeepSeek 对话的第一次请求会加入匹配到的本地记忆和 `memory_save` 协议。模型回复可以新增记录，但不能编辑或删除现有 Memory；这些操作仍须由用户在本地管理器中明确执行。扩展会观察官方 completion 端点，并且只把最新渲染且未确认为 user 的消息作为完整保存调用的兜底来源。兜底会通过同一条仅追加宿主操作发送调用，并从可见 Markdown 中移除调用；已确认为 user 的消息和推理块不在处理范围内。保存要求请求 hook 为当前回复发布短生命周期的 completion 授权，并由一次成功保存消费。没有 role 的最新回复只能在授权存活时保存；没有授权时仍可隐藏技术标签，但不会补录历史消息。扩展、宿主页、数据库或管理页故障不会终止 Chat 或 Harness。

应用菜单和托盘中的 **Memory** 菜单可以查看、搜索、筛选、新增、编辑、删除和置顶本地记录。**导出 Memory JSON…** 使用系统保存对话框；**导入 Memory JSON…** 使用系统文件对话框，校验文档后在一个 IndexedDB 事务中提交全部记录。Memory 只存在于 `persist:dsh-deepseek-chat`；Harness 使用 `defaultSession`，不会加载该扩展。

### 导航与故障

目前只有精确的 HTTPS 来源 `https://chat.deepseek.com` 在 Chat 内受信任。同源新窗口使用同一个受限分区。无关 HTTPS 新窗口请求会在系统浏览器中打开；顶层跳转会被取消，并通过本地外壳提供打开选项；无关重定向、格式错误的 URL、HTTP 和非 Web 协议会被阻止。Chat 视图失败时还会提供固定官方网站 URL 的系统浏览器回退。需要其他来源的认证方式仍不受支持，直到该精确来源及其流程通过发布审查与测试。

Harness 仍限制在经过验证的回环来源。用户导航和新窗口请求如果指向其他 HTTP 或 HTTPS 来源，会在系统浏览器中打开；外部重定向和其他协议则会被阻止。

Host 启动失败、Host 意外退出或 Harness renderer 失败时，只会把 Harness 标记为不可用并提供 Harness 重试。Chat 加载失败、renderer 失败或无响应时，只会把 Chat 标记为不可用，并提供 Chat 重试和浏览器回退。清除或重试任一模式都不会清除或重启另一个模式。

原生窗口外观按宿主平台区分。macOS 使用无边框内嵌标题栏、交通灯和侧栏 vibrancy；切换器位于该标题栏的交通灯右侧。Windows 保留系统边框、阴影、缩放与 Snap 行为以及 Windows 11 圆角，隐藏标题栏把切换器放在左侧，并把原生窗口按钮留在最右侧。关闭状态本地 chrome 仅延伸到实际控件边缘，shell 拖拽区域从最大关闭控件范围之后开始，因此原生拖拽命中测试和透明像素都不会拦截模式或网站控件。Windows acrylic 和 macOS vibrancy 只透过侧栏，会话区与详情区保持不透明。Linux 使用无边框标题栏和不透明侧栏降级样式。

### Desktop 通知

应用和托盘设置提供 Chat 回复、Harness 完成/失败/等待操作、站内提示及普通通知强调色（主题、DeepSeek、蓝色、紫色、绿色或自定义颜色）。macOS 还提供 Dock 数量设置；Windows 菜单不显示该项。失败保持红色，等待操作保持琥珀色。未读圆点位于 Desktop 的 Chat/Harness 切换入口，无障碍标签也包含数量。关闭展示不会标记已读。

Chat 与 Harness 的来源级 attention 在浅色和深色主题下共用固定通知红（`#ff3b30`），独立于选中状态和普通通知强调色。来源切换入口保留该布尔圆点；macOS Dock 数字把持久化的 Chat 与 Harness pending 数量相加，每个未见结果计一次，显式进入某一来源只清除该来源的计数，点击通知也属于显式进入。关闭 Dock 展示只隐藏数字，不丢弃提示，普通未读不会进入该数字，数字也会跨重启恢复。Chat attention 由已审计的 completion、regenerate、continue 端点成功完成触发；用户主动 stop 的生成不会被播报。

Desktop 状态文件通过原子写入保存最小通知元数据和去重记录，不保存消息正文或 Memory 内容。点击通知恢复窗口并选择对应模式。只有确认正在查看准确目标时才标记对应事件已读；未知目标保留未读。macOS 与 Windows 原生通知使用固定本地化文案。Dock 数字仍仅用于 macOS；Windows 使用系统原生通知与站内未读提示。

**基础 Harness 通知：**仅对指纹匹配的已审计托管运行时，通过只读 `session/list` 和 `session/page` 轮询启用后台失败与完成通知。通知观察不打开 `follow` 或 `$events`。窗口聚焦、可见且未最小化时抑制原生投递；隐藏或最小化时允许投递。每个未见 Harness 结果都会点亮 Harness 圆点并向 Dock 数字加一，其 receipt 保持已读且不进入普通未读；点击后恢复 Harness。分叉会话和子任务均排除。首次观察或连续性中断只建立基线，不补发历史；有界轮询可能漏报。参见[基础通知决策](../../.agents/notes/implemented/feature/2026-09-14-harness-background-failure-notifications.md)。

### Harness 更新卡片

托管 Harness 的安装、更新与重装会在标题栏 chrome 内打开一张卡片，并在事务运行期间保持显示。卡片由 chrome 渲染器在自身卡片尺寸的原生矩形内绘制，该矩形按卡片的圆角半径而非窗口半径进行裁切，因此更新全程 Chat 与 Harness 视图仍保留指针。卡片占用该矩形期间，模式切换暂时让位；将卡片暂时收起会归还这些控件，并且事务出结果后卡片仍会重新出现。

卡片上的每一项主张都来自运行时。`managed-harness.ts` 在进入每个阶段时即时上报——`preparing`（registry 往返与持久 pending 标记）、`installing`（固定版本的 npm 子进程）、`verifying`（暂存的 manifest、版本、完整性与入口比对）以及 `health`（在一次性 Harness home 中启动候选版本）——并同时给出运行时自己的判断：在该阶段停止是否会留下未完成的半成品。下载不是独立阶段：单个 `npm install` 子进程完成解析、拉取和写入，且不发出结构化事件，因此卡片写明正在下载并安装，而不是依据耗时把一个进程拆分成推测出的状态。没有任何阶段按计时器推进，也不显示百分比。完成与否按运行时自己保留的状态判定，因此退出码为 0 但版本未发生移动会作为失败上报并同时给出两个版本。

取消在 `preparing` 与 `installing` 阶段被接受，这两个阶段不会向事务的 staging 目录之外写入任何内容；在 `verifying` 与 `health` 阶段被拒绝，那里正是晋升门；此时控件变灰、保持可点击，并说明它不会动作的原因。取消请求在发出前先经确认，运行时拒绝的取消不会被呈现为已经发生。原版本号在事务开始前读取，因此重装正在运行的版本绝不会被绘制为升级，完成后的卡片说明被晋升的版本在 Harness 重启后生效。回滚保留其原有的原生对话框报告方式，Harness 标签页的首次安装按钮保留其自身路径。参见[更新卡片决策](../../.agents/notes/implemented/feature/2026-09-18-harness-update-card.md)。

## 打包

本地打包命令会执行完整的仓库构建，为 Managed Harness 暂存固定版本 npm 运行时，并为当前平台生成未封装应用。固定 Harness 依赖闭包不会进入最终包：

```sh
pnpm run package:desktop
```

Electron Builder 运行前，该命令会通过 Electron 自带的校验安装器准备当前平台的原生 runtime。因此，干净安装无需手工预热 Electron 缓存。

打包后的应用通过 Electron 的 Node 模式，在独立进程内安装并运行所选官方版本的 `@deepseek-ai/dsh` CLI。应用因此保留受 supervisor 管理的 Host 生命周期，无需携带第二个 Node 可执行文件或固定 Harness 依赖闭包。固定版本 npm 运行时会在打包前和 `afterPack` 检查中验证。macOS 和 Windows 都使用受跟踪的 `apps/desktop/build/icon.png` 原始文件；仓库不预处理图标，也不提交平台专用图标变体。

### Windows 本地试用

在 Windows x64 上构建未签名的当前用户 NSIS 安装器和 ZIP，不执行发布：

```sh
pnpm --filter @deepseek-ai/dsh-desktop run dist:win
```

产物位于 `apps/desktop/dist/`。安装器创建桌面与开始菜单快捷方式，卸载时保留应用数据。按 F10 打开应用菜单；关闭窗口或按 Alt+F4 隐藏窗口，点击彩色托盘图标可恢复窗口，包括从最小化状态恢复。通过托盘退出 Desktop。Windows 菜单省略 macOS 专属的隐藏、服务、语音及文本替换项。Windows 支持 Chat 与 Harness 的系统通知及站内未读提示；真实事件仍需登录 Chat 或可用的 Harness 才能触发。打包时使用 Windows 应用自身的可执行文件验证固定版本的 npm。

Windows 恢复流程等待引用托管程序目录的进程退出。如果无法枚举进程或文件仍在使用，安装、更新与回滚会一直受阻，直到重启后恢复成功。恢复流程不会凭旧 PID 记录终止进程。

Windows 默认启动时，可替换的 Desktop 状态文件和托管 Harness 安装位于 `%USERPROFILE%\\.deepseek-desktop`；Chromium 的 Chat 配置、登录和 Memory 仍保存在 Electron 的漫游用户数据目录。显式传入 `--user-data-dir` 时，所有 Desktop 自有文件都留在所选配置目录。升级后首次启动仅在新状态文件不存在时，才从旧状态文件复制已验证的模式、外观和语言偏好；旧文件与浏览器配置不会被移动或删除。

托管安装 manifest 将 Cordis 4.0.2 与 `cordis-plugin-loader` 1.0.3 固定为一组。Harness 1.0.5 发布包在安装根目录使用 4.0.4 与 1.0.5，而 DSH 子树仍使用旧版本；递归 profile entry 因此会报 `entry._await is not a function`。旧版本配对已在仅含程序包的 synthetic profile 中启动，并到达本机 HTTP token fence。试用机上的干净 npm 暂存安装尚未验证，本轮也没有修复当前默认 profile。必须等暂存安装通过安装器健康检查后，才能替换现有托管程序目录；不要手动覆盖该目录。

### 自动 GitHub 发布

推送一个版本与 `apps/desktop/package.json` 一致、且位于 `main` 历史中的 `vX.Y.Z` 标签会启动 `.github/workflows/desktop-release.yml`。原生 runner 构建 macOS Apple Silicon DMG/ZIP 和 Windows x64 NSIS/ZIP。macOS 产物仅使用 ad hoc 签名，未使用 Developer ID 签名或公证。Windows 正式发布必须配置 PFX、密码、精确匹配的预期 Publisher Subject 和 RFC 3161 时间戳；安装器与应用可执行文件必须通过可信 Authenticode 验证后才可上传。签名输入缺失或验证失败都会阻止发布。工作流先创建草稿 Release，再核对明确列出的产物清单及 SHA-256；不会覆盖哈希不匹配的已有产物。工作流不发布 Desktop 更新器 metadata。

### 已签名的 macOS DMG

macOS 发布命令要求构建用户的 Keychain 中安装有效的 `Developer ID Application` 身份，且证书与私钥必须同时存在。它还需要一组完整的公证凭据。Keychain profile 可以避免应用专用密码进入仓库或 shell 历史记录：

```sh
xcrun notarytool store-credentials "dsh-notary" --apple-id "<Apple ID>" --team-id "<Team ID>"
```

`notarytool` 会交互式请求秘密。使用已存储的 profile 构建已签名、开启 hardened runtime 且已公证的 DMG：

```sh
APPLE_KEYCHAIN_PROFILE=dsh-notary pnpm run dist:mac:desktop
```

现有秘密文件可以提供 `MAC_CERT_P12_BASE64`、`MACOS_SIGN_IDENTITY`、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD` 和 `APPLE_TEAM_ID`，无需把证书导入持久 Keychain：

```sh
node --env-file=/absolute/path/to/macos-signing-secrets.env --import tsx apps/desktop/scripts/release-mac.ts
```

Electron Builder 会把该 Base64 PKCS#12 证书导入临时 Keychain，并在构建结束时删除。wrapper 不会把签名和公证变量传给仓库构建与运行时暂存子进程，只会将其传给 Electron Builder。秘密文件及其路径都不会受版本控制。

发布预检查会在仓库构建前运行。如果宿主不是 macOS、所提供身份不是 `Developer ID Application` 身份、签名凭据不完整、签名发现被禁用，或公证凭据缺失或不完整，预检查都会失败。未提供 PKCS#12 凭据组时，Keychain 中必须存在带私钥的可用 `Developer ID Application` 身份。除 Keychain profile 外，该命令也接受完整的 Apple ID 凭据组（`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD` 和 `APPLE_TEAM_ID`），或 App Store Connect API 密钥组（`APPLE_API_KEY`、`APPLE_API_KEY_ID` 和 `APPLE_API_ISSUER`）。

构建成功后，挂载生成的 DMG，再验证其中应用的签名、Gatekeeper 评估和已装订的公证票据：

```sh
DMG_PATH="$(find apps/desktop/dist -maxdepth 1 -type f -name '*.dmg' -print -quit)"
MOUNT_POINT="$(mktemp -d)"
hdiutil attach "$DMG_PATH" -mountpoint "$MOUNT_POINT" -nobrowse -readonly
APP_PATH="$MOUNT_POINT/DeepSeek Desktop.app"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
spctl --assess --type execute --verbose=4 "$APP_PATH"
xcrun stapler validate "$APP_PATH"
hdiutil detach "$MOUNT_POINT"
rmdir "$MOUNT_POINT"
```

## 已知限制

首个桌面装配使用回环 HTTP Host。renderer 和 Host 协议保持不变，因此后续可替换为 GUI 架构预留的 IPC carrier，而无需改动产品功能。

GitHub Actions 的 Windows x64 正式发布要求可信 Authenticode 签名；签名凭据不可用时会失败关闭。上文的未签名 Windows 1.0.5 本地试用构建命令仅供本地测试。macOS 发布产物仍只有 ad hoc 签名，未使用 Developer ID 分发签名或公证。Linux 发布打包目前不在目标范围内。

本地 Electron 场景验证 Desktop 生命周期与存储策略，不验证在线 DeepSeek 网站的兼容性。DeepSeek 可以独立改变认证来源、WAF 行为、页面要求或嵌入策略。任何登录方式只有在 macOS 和 Windows 上都通过以下冒烟流程后，才具备发布资格：

1. 在嵌入式 Chat 中完成该登录方式，并记录每个顶层认证来源。
2. 重启 Desktop 并验证登录仍然存在；切换到 Harness 再返回，验证 Chat 页面状态得到保留。
3. 验证同源认证窗口、外部 HTTPS 链接、显式重新加载 Chat 和浏览器回退。
4. 清除 Chat 数据，验证嵌入登录已移除且 Harness 数据没有变化。
5. 触发 Chat 加载或 WAF 故障以及 Host 故障，验证另一个模式仍然可用。

公开分发还需要单独审查 DeepSeek 当前的服务条款与品牌规则。本仓库未记录重新分发或嵌入该网站的许可。

## 模型体验

桌面壳和已选模式状态不会增加模型可见输入。新 Chat 对话中，Memory-only 扩展会把筛选后的本地 Memory 和有限工具协议加入发往官方网站的请求。复用的 Web profile 持有该上下文和持久数据；Chat 内容与 Memory 都不会进入 Harness 提示词、会话事件或遥测。

托管安装在提升版本前，将已安装 package-lock 的完整性值与解析出的官方发布值进行比较。替换已有版本时，恢复目录会保留至版本状态提交；中断的替换会还原该目录。托管 Node 子进程会在 Desktop 父进程退出后终止。回收孤儿进程必须同时匹配推导出的托管 CLI 路径、预期命令和实时进程环境中的单次启动身份；旧格式或不匹配的记录不能授权发送信号。
