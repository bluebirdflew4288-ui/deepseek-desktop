# Agent Note: Desktop notification ledger

Status: implemented

[简体中文](2026-09-13-desktop-notification-ledger.zh.md)

## Problem

App focus alone cannot determine whether a user saw a particular Chat reply or Harness task outcome. Native delivery is also distinct from reading, and process shutdown is not a task outcome.

## Decision

[Desktop notifications](../../../../apps/desktop/src/desktop-notifications.ts) retain only occurrence identity, source, target identity, outcome, timestamp, read state, and delivery attempt state. The existing atomic Desktop state document and serialized writer own durability. Dispatch follows durable recording; restored occurrences never dispatch again. Read tombstones remain for deduplication, without automatic expiry that could re-alert an old occurrence.

A focused, visible, non-minimized window suppresses unread only when the provider confirms the same target. Unknown identity remains unread across mode changes and notification clicks. Desktop menus own presentation switches and ordinary accent; failure and action-required colors remain semantic.

## Alternatives considered

**App-wide clearing.** It marks another task read while the user views unrelated content.

**DOM or transport-end inference.** Memory save tags, XHR loadend, page readiness, and Host exit do not prove top-level success. The official Chat and managed Harness views expose no Desktop current-target bridge in this integration, so exact-target unread accounting stays disconnected; both sources produce notification-only occurrences instead.

The inspected official Chat asset `main.d69e3d8c16.js` exposes candidate request/response message IDs, session IDs, message statuses, and a separate stop request. Its SSE `finish` frame carries no success result. A public asset hash identifies an implementation snapshot, not a supported versioned completion or visibility protocol. Chat therefore derives its occurrences from the audited completion, regenerate, and continue request lifecycles plus the explicit stop request, and claims no current-target visibility.

The installed managed directory `0.1.5-rc.1` contains the CLI at that version and session/frontend packages at `0.1.5-rc.2`. Its generated RPC declarations expose `session/follow`, session format 3, event sequence numbers, and discriminated `turn/end` reasons. An isolated launch of the installed Electron executable and CLI produces a real `turn/end` error with `MISSING_CREDENTIAL` over the WebSocket mux. This establishes transport and one failure path. The managed reader polls `session/list` and `session/page` for root-session failures and completions without following or activating a cold Agent. `blocked` denotes a rejected pre-step, while approval and user-question requests use separate waterfall events. The client-local selected-session service has no verified Desktop visibility bridge; unknown target identity remains unread. These gaps block the exact-target integration without implying that the installed runtime lacks task events.

**Native delivery retries after restart.** The OS does not participate in the state-file transaction. Persisting an attempt first favors avoiding duplicates over guaranteed delivery in the crash interval before the native call.

## Consequences

Source attention is separate from ordinary unread: `chatAttention` and `harnessAttention` are optional durable booleans, rendered in fixed notification red, and `chatPendingCount`/`harnessPendingCount` count the unseen occurrences behind them. Explicit source entry clears only that source, and the macOS Dock renders the two counts as one number through `app.setBadgeCount`, where zero clears it. This preserves result visibility across restart without creating a receipt, and ordinary unread never feeds the number. Chat attention is written by the audited completion, regenerate, and continue endpoints.

The notification-only Harness production path is governed by the [background failure decision](2026-09-14-harness-background-failure-notifications.md); it does not use exact-target unread accounting.

The state policy, native adapter, menus, and chrome are implemented. Chat and Harness both produce notification-only occurrences — Chat from the audited completion lifecycle and Harness from the audited read-only poller — while exact-target unread still requires a versioned visibility protocol. Session navigation remains provider-owned; Desktop clicks restore the corresponding mode without claiming a target was viewed. No Harness update transaction, Memory model, official renderer, or Harness home participates in the ledger.

Focused policy tests and a local Electron fixture cover unread persistence, ordinary versus semantic color, minimized-window restoration, and the persisted pending counts behind the Dock number. They do not establish macOS Notification Center permission on their own. Read tombstones accumulate until a provider replay watermark makes safe pruning possible.
