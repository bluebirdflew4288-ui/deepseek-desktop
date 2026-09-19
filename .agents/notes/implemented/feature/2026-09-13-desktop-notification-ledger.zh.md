# Agent Note: Desktop 通知记录

Status: implemented

[English](2026-09-13-desktop-notification-ledger.md)

## Problem

应用获得焦点不能证明用户看过某条 Chat 回复或 Harness 任务结果。原生通知投递也不等于已读，进程关闭不等于任务结果。

## Decision

[Desktop 通知](../../../../apps/desktop/src/desktop-notifications.ts)只保留事件标识、来源、目标标识、结果、时间戳、已读状态和投递尝试状态。现有 Desktop 原子状态文件与串行写入器负责持久化。记录落盘后才投递，恢复的事件不会再次投递。已读记录保留用于去重，不通过自动过期让旧事件再次弹出。

只有窗口聚焦、可见、未最小化且提供方确认同一目标时，才抑制未读。身份未知的事件在切换模式和点击通知后仍保留未读。Desktop 菜单管理展示开关与普通强调色；失败和等待操作保持语义色。

## Alternatives considered

**应用级全部清除。** 用户正在查看无关内容时，这会把其他任务标为已读。

**通过 DOM 或传输结束推断。** Memory 保存标签、XHR loadend、页面就绪和 Host 退出都不能证明顶层任务成功。当前集成中，官方 Chat 与托管 Harness 视图没有向 Desktop 暴露当前目标桥接，因此精确目标未读记账仍未接通；两个来源改为产生 notification-only 事件。

检查到的官方 Chat 资源 `main.d69e3d8c16.js` 包含候选请求/回复消息 ID、会话 ID、消息状态和独立停止请求。其 SSE `finish` 帧不携带成功结果。公开资源哈希只能标识实现快照，不能证明受支持且带版本的完成或可见性协议。因此 Chat 的事件来自已审计的 completion、regenerate、continue 请求生命周期以及显式停止请求，且不宣称当前目标可见性。

已安装的托管目录 `0.1.5-rc.1` 包含该版本 CLI，而 session/frontend 包为 `0.1.5-rc.2`。其生成的 RPC 声明提供 `session/follow`、session 格式 3、事件序号和可区分的 `turn/end` 原因。使用已安装 Electron 可执行文件和 CLI 的隔离启动，通过 WebSocket mux 产生了真实的 `turn/end` 错误 `MISSING_CREDENTIAL`。这证明传输和一条失败路径。托管读取器通过轮询 `session/list` 与 `session/page` 获取根 session 的失败与完成，不 follow、不激活冷 Agent。`blocked` 表示执行前检查拒绝，审批和用户提问则使用独立 waterfall 事件。客户端本地的已选 session 服务没有经过验证的 Desktop 可见性桥接；未知目标仍保留未读。这些缺口阻塞精确目标集成，但不意味着安装版缺少任务事件。

**重启后重试原生投递。** 操作系统不参与状态文件事务。先持久化投递尝试可以避免重复，但无法保证记录落盘与原生调用之间发生崩溃时仍能投递。

## Consequences

来源级 attention 与普通未读分离：`chatAttention` 和 `harnessAttention` 是可选的持久化布尔值，以固定通知红显示；`chatPendingCount` 与 `harnessPendingCount` 记录其背后未见事件的数量。显式进入来源只清除该来源，macOS Dock 通过 `app.setBadgeCount` 把两个计数合成一个数字，归零即清除。这让结果提示跨重启保留而不创建通知记录，普通未读也不会进入该数字。Chat attention 由已审计的 completion、regenerate、continue 端点写入。

仅通知的 Harness 生产路径由[后台失败通知决策](2026-09-14-harness-background-failure-notifications.md)约束，不使用精确目标未读计数。

状态策略、原生适配器、菜单和 chrome 已实现。Chat 与 Harness 都会产生 notification-only 事件——Chat 来自已审计的 completion 生命周期，Harness 来自已审计的只读轮询器——而精确目标未读仍需要带版本的可见性协议。Session 导航仍归提供方所有；点击通知只恢复对应模式，不宣称目标已查看。Harness 更新事务、Memory 模型、官方渲染器和 Harness home 均不参与通知记录。

聚焦策略测试和本地 Electron fixture 覆盖未读持久化、普通色与语义色、最小化窗口恢复，以及 Dock 数字背后的持久化 pending 计数。它们本身不能证明 macOS 通知中心权限。已读记录持续累积，安全裁剪需要提供方的重放水位。
