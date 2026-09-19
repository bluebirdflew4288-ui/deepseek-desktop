# Agent Note: Harness background failure notifications

Status: implemented

[简体中文](2026-09-14-harness-background-failure-notifications.zh.md)

## Problem

Precise current-session visibility has no supported Desktop bridge. A notification observer must not activate cold Agents or participate in interactive waterfall delivery. Reliable observation is more important than covering every outcome.

## Decision

The [Desktop reader](../../../../apps/desktop/src/harness-notification-runtime.ts) admits only the audited installed module fingerprints and uses the authenticated Harness Electron session to call `session/list` and `session/page`. These reads do not activate an Agent. Cached projection sequence numbers are historical cuts, not guaranteed latest cursors. Each single-flight cycle waits ten seconds after completion, selects at most 128 summaries, reads at most eight 32-message pages, and caps each response at 512 KiB with a three-second timeout.

The [poll policy](../../../../apps/desktop/src/harness-notification-poll.ts) excludes every lineage-bearing or non-root-origin session, including ordinary forks. First observation, restart, and missing continuity establish only a cursor baseline: a turn may begin before that previous cursor or observation watermark, so turn evidence is rebuilt from the bounded page. Freshness is decided by a matching `turn/end.seq > previous cursor`: the bounded page must still contain a complete `turn/start` and valid root-user evidence, and completed additionally requires non-empty assistant text output. A `turn/end.seq <= previous cursor` historical result is never replayed. When the bounded page cannot prove that complete evidence, the cycle fails closed and does not backfill. Legal `session/page` event types that Desktop does not consume are skipped and never change turn state. Malformed list/page/record payloads, identity failures, sequence-continuity violations, and malformed `turn/end` structure still fail closed and reset observation. Sequence regression disables that session for the remaining observer lifetime. One accepted terminal event emits one failure or completion keyed by session ID and terminal sequence; plugin context is not user input. Production completion is enabled only under the assistant-output requirement above, so inherited history, empty work, and forks cannot produce an alert. Cancellation and waiting never produce alerts.

Events enter the existing [notification owner](../../../../apps/desktop/src/desktop-notifications.ts) with background-only presentation. Durable receipts are excluded from unread accounting. A focused, visible, non-minimized window suppresses native delivery regardless of selected mode; focus is checked again after persistence. Clicks restore Harness without session navigation. Chat has its own notification-only producer derived from the audited completion lifecycle; exact-target ledger semantics remain disconnected for both sources.

## Alternatives considered

**Follow every session.** Installed `session/follow` promotes cold prepared sessions. A prior running-state check cannot remove the race with inactivity.

**Subscribe to global events.** `$events` registers a waterfall delivery client; a silent observer can affect interaction settlement.

**Complete historical recovery.** Fork prefix ownership and paginated backfill add complexity without serving the best-effort background-alert scope. Baselines and fork exclusion accept missed notifications instead.

## Consequences

Failure alerts are best-effort and may be missed during foreground use, startup, disconnection, cache lag, long turns, or polling limits. Forks and delegated sessions never alert. Module changes disable observation until audited; session format alone cannot version RPC semantics. The reader stores no separate checkpoint file and retains no message content after processing. Existing durable deduplication favors avoiding repeat alerts over guaranteed delivery.

Installed-runtime probes verify read-only failure extraction and unchanged cold-session history; focused tests cover replay, user identity, cancellation, and presentation. They do not verify successful model completion, macOS Notification Center delivery, or final packaged-app acceptance.
