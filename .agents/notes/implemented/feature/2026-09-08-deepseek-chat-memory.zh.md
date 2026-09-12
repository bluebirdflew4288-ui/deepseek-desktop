# Agent Note: DeepSeek Chat 本地 Memory

Status: implemented

[English](2026-09-08-deepseek-chat-memory.md) | 中文

## Problem

Desktop 能在多次启动之间保留官方 DeepSeek Chat profile，但不同对话无法复用长期有效的用户偏好或背景事实。直接加载完整 DeepSeek++ 浏览器扩展会带入 Electron 不支持的 MV3 Service Worker 行为、宽泛浏览器能力、无关依赖和不属于双模式桌面产品的权限。Memory 还必须与 Harness 隔离，且不能让任何一个主模式依赖这一增强层。

## Decision

Desktop 在 `apps/desktop/resources/deepseek-memory/` 随包提供一个 Electron 专用、无第三方运行依赖的 Memory-only 衍生版本。它保留 DeepSeek++ 的 Memory 记录形状与 IndexedDB 迁移概念、筛选与提示词增强行为、直接 XML 保存协议、completion 请求与回复拦截、管理操作和 JSON 导入导出行为。Apache-2.0 许可证与修改说明随扩展一起打包。

主进程通过 `apps/desktop/src/deepseek-memory-extension.ts` 中的 `DeepSeekMemoryRuntime` 管理生命周期。每次启动时，它会校验最小 MV3 manifest，只把解包扩展加载到 `persist:dsh-deepseek-chat`，核验预期扩展 ID，并让一个启用沙箱的隐藏扩展页面常驻作为运行宿主。Harness 继续使用 `defaultSession`，其中不存在该扩展。扩展加载和宿主页故障会单独收敛并报告，不会终止 Chat、Harness 或桌面进程。

### Identity and persistence

manifest 包含固定 RSA 公钥；Chromium 从该公钥派生出的 ID 是 `gnidildjjigkpideacmahnfagflchfpk`。主进程先自行派生并校验 ID，再校验 Electron 的实际加载结果。Memory 在扩展来源下使用名为 `DeepSeekPP` 的 IndexedDB。固定公钥让该来源不依赖解包资源路径、应用位置或打包输出路径。

### Request boundary

两个 content script 只在 `https://chat.deepseek.com/*` 运行：隔离世界桥和主世界请求 hook。hook 只增强新对话的第一条 completion 请求；Memory 不可用时会发送原请求。选中的记录会编码为不受信任的 JSON 数据，其中可能改变结构的标记字符会被转义。completion 回复通过线性、有限的扫描识别直接 `memory_save` XML 调用。隔离世界 content script 还会把最新渲染且未确认为 user 的消息作为有限兜底：完整调用仍通过同一条仅追加宿主路径转发，同时从可见 Markdown 中移除；只有宿主接受的调用才会登记指纹，因此 SPA 重新渲染不会重复发送已投递的调用，而被拒绝的投递会重试而不是直接丢弃。保存要求请求 hook 为当前回复发布短生命周期的 completion 授权，并由一次成功保存消费。没有 role 的最新回复只能在授权存活时保存；确认为 user 的消息完全不被处理，推理块不在处理范围内，缺少授权的消息仍可隐藏技术标签，但永远不会补录历史 Memory。模型输出可以新增有效记录，但不能编辑或删除现有 Memory。manifest 不包含扩展 API 权限、可选权限、后台 worker 或任意站点访问权限。

### User operations

应用菜单和托盘菜单可以打开扩展来源的管理页，支持查看、搜索、筛选、新增、编辑、删除和置顶。编辑与删除是用户在管理器中主动执行的操作，不由模型授权。导入导出使用 Electron 系统打开／保存对话框。导入会先校验文档，再在一个 IndexedDB 事务中提交全部记录。清除 Chat 数据前会警告该操作也会删除登录状态和本地 Memory，便于用户先导出 JSON。

## Alternatives considered

- 不加载未经修改的完整 DeepSeek++：Electron 没有提供它所需的完整 MV3 后台和 Chrome API 环境，而且其功能和依赖闭包超出 Memory 范围。
- 不在完整后台周围增加兼容桩：这样仍会执行和分发隐藏的、不受支持的模块。
- 本阶段不改用 Desktop 自有数据库：已经证明可行的同 Session 扩展宿主页能以更小兼容边界保留现有 Memory 模型。
- 不把扩展加载到 `defaultSession`：这会让 Harness 接触 Memory，并把原本独立的两个模式耦合起来。
- 不从解包路径派生扩展身份：重新构建、移动和升级应用可能产生新的扩展来源，使原 IndexedDB 无法访问。

## Consequences

Chat 获得本地长期 Memory 和明确的 JSON 可迁移路径，且不新增 npm 生产依赖。自动 Memory 被刻意限制为只追加；修正和删除必须通过本地管理器执行，从而避免不受信任的模型输出静默改动已有记录。随包 fork 排除了 MCP、Shell、Native Messaging、浏览器控制、Debugger、OAuth、WebDAV／云同步、Pyodide、Offscreen、悬浮聊天、自动化、Pet、主题增强、Web Search／Fetch、Official API 和任意站点权限。固定扩展 ID 成为持久数据契约，没有迁移方案时不得更改。清除 Chat 分区也会清除 Memory。Desktop 打包会在 Electron Builder 运行前准备通过校验的当前平台原生 Electron runtime，因此干净安装不依赖预热缓存。请求适配器和渲染兜底依赖官方 DeepSeek completion 与 assistant DOM 契约，因此发布前的真实账户验证必须覆盖注入、工具解析、自动保存、可见标签移除、召回、登录保持、完全退出重启、JSON 恢复和 Harness 隔离，并同时运行本地 Electron 生命周期测试。
