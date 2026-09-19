# Agent Note: Harness 后台失败通知

Status: implemented

[English](2026-09-14-harness-background-failure-notifications.md)

## Problem

当前 session 的精确可见性没有受支持的 Desktop 桥接。通知观察不能激活冷 Agent，也不能参与交互 waterfall 投递。可靠观察比覆盖全部结果更重要。

## Decision

[Desktop 读取器](../../../../apps/desktop/src/harness-notification-runtime.ts)只接受已审计的安装模块指纹，使用 Harness Electron 会话已有认证调用 `session/list` 和 `session/page`。这些读取不激活 Agent。缓存投影序号是历史截点，不保证是最新游标。单次轮询结束后等待十秒，最多选择 128 个摘要、读取 8 页且每页最多 32 条消息，每个响应限制为 512 KiB，超时三秒。

[轮询策略](../../../../apps/desktop/src/harness-notification-poll.ts)排除所有带 lineage 或非根来源的 session，包括普通 fork。首次观察、重启和连续性缺失只建立游标基线：turn 可以在该 previous cursor 或 observation watermark 之前开始，因此 turn evidence 会在有界 page 中重新构建。freshness 由匹配的 `turn/end.seq > previous cursor` 决定：有界 page 必须仍能提供完整的 `turn/start` 与有效根用户证据，completed 还额外要求非空 assistant 文本输出。`turn/end.seq <= previous cursor` 的历史结果绝不 replay。有界证据不完整时按 fail-closed 处理，不回填。已审计 `session/page` 返回的合法但 Desktop 不消费的 event type 直接 skip，不改变 turn state。malformed list/page/record、identity 失败、sequence continuity 违规以及 malformed `turn/end` 结构仍然 fail closed / reset observation。序号回退会在观察器剩余生命周期内停用该 session。一次被接受的终态事件按 session ID 与终态序号产生一次失败或完成事件；插件上下文不算用户输入。生产成功通知仅在满足上述 assistant 输出要求时启用，因此继承历史、空工作和分叉都不会产生通知。取消和等待均不产生通知。

事件以 background-only 展示方式进入现有[通知管理器](../../../../apps/desktop/src/desktop-notifications.ts)。持久化去重记录不参与未读计数。窗口聚焦、可见且未最小化时，不论选中模式都抑制原生投递；持久化后再次检查焦点。点击只恢复 Harness，不进行 session 导航。Chat 有自己基于已审计 completion 生命周期的 notification-only 生产方；两个来源的精确目标未读语义仍未接通。

## Alternatives considered

**Follow 全部 session。** 安装版 `session/follow` 会激活冷 prepared session。预先检查 running 不能消除与转为空闲的竞态。

**订阅全局事件。** `$events` 会登记 waterfall delivery client；静默观察者也可能影响交互结算。

**完整历史恢复。** Fork 前缀归属和分页回填增加复杂度，不符合尽力投递的后台提醒范围。采用基线和排除 fork，接受由此产生的漏报。

## Consequences

失败通知属于尽力投递，前台使用、启动、断线、缓存滞后、长 turn 或轮询限制均可能造成漏报。Fork 和委派 session 不通知。模块变化会关闭观察，直到重新审计；仅凭 session 格式不能约束 RPC 语义。读取器不建立独立 checkpoint 文件，处理后不保留消息内容。现有持久化去重优先避免重复提醒，不保证必达。

安装版探针验证了只读失败提取和冷 session 历史不变；聚焦测试覆盖重放、用户身份、取消和展示。它们不能证明真实模型成功、macOS 通知中心投递或最终安装包验收。
