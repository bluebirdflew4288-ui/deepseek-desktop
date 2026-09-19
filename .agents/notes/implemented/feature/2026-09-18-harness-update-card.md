# Agent Note: Harness update card reports real transaction stages

Status: implemented

[简体中文](2026-09-18-harness-update-card.zh.md)

## Problem

A managed Harness transaction runs for minutes and told the shell nothing about itself. The Harness menu items that start install, update, and reinstall returned immediately, the transaction ran on the managed runtime's own queue, and its first message to the user was whatever native dialog it produced when it finished. A registry round trip is bounded at 30s, one package-manager run at 15 minutes, and a cold resolution of the official closure fetches 521 packages, so the longest legitimate case looked exactly like a dead button. The [managed Harness runtime note](../../proposed/architecture/2026-09-10-managed-harness-runtime.md) named this as an accepted risk while no surface existed to discharge it.

Nothing in the transaction reported progress to begin with. The runtime writes one JSON line per phase into its rotating diagnostics log, which is a file for post-hoc diagnosis that no user opens mid-update, and the shell's only other knowledge of a running transaction was a disabled menu line. Adding a surface therefore required deciding what could honestly be shown, not just where to show it.

## Decision

[`harness-update-view.ts`](../../../../apps/desktop/src/harness-update-view.ts) holds the shell's state for one staging transaction: running with a stage, completed with the retained version pair, failed with the runtime's reason, or cancelled. It opens before the transaction is started and closes when the transaction settles, so a click is answered in the same turn. The card itself is drawn by the title-bar chrome renderer, which already owns a native rectangle above both content surfaces, and Electron main gives that rectangle the card's own size rather than the window's, so the Harness and Chat surfaces keep the pointer while an update runs. The card sits horizontally centered on the content with its middle one third of the content height down, matching where the native result dialog for an unchanged Harness already appears rather than the geometric middle.

The runtime, not the view, decides what is true. [`managed-harness.ts`](../../../../apps/desktop/src/managed-harness.ts) reports each stage as it enters it, together with whether that stage can be stopped, and the view forwards both without inventing either. `busy` now covers the whole staging transaction instead of only the part after the registry read, which is what keeps the menu from queueing a second one behind the first.

## Stages a transaction can prove

`preparing` is the registry round trip and the durable pending marker, `installing` is the package-manager child, `verifying` is the staged manifest, version, integrity, and entrypoint comparison, and `health` launches the candidate against a disposable Harness home. These are the four calls the transaction already makes in the order it makes them, and the diagnostics log has always named them.

Download is not a stage of its own. The official release is obtained by one `npm install` child that resolves, fetches, and writes without emitting any structured event, and it runs with `--loglevel=error`, so the only observable boundaries around it are "started" and "exited". The card's second line therefore says it is downloading and installing, which is what the child is doing, rather than splitting one process into two states guessed from elapsed time. The install line's own output tail is retained for the diagnostics log and never parsed for presentation.

Completion is claimed only against the runtime's own retained state: a promoted outcome whose version is not the version now in use is reported as a failure naming both, because an exit code of 0 is not the condition the user cares about.

The completed card names a version to come from only when the version in use actually moved, so a reinstall of the version already running is never drawn as an upgrade: the outgoing version is read before the transaction starts, and `retained.previous` stays what it is for the rollback path. The same card states that the promoted version takes effect when the Harness is restarted, because until that restart the live process still serves the outgoing one.

## Cancellation

Cancel is accepted in `preparing` and `installing` and refused in `verifying` and `health`, and that verdict is produced once inside the runtime and carried to the card as data, so the control cannot advertise a safety the transaction does not provide.

The accepted stages are the two that write nothing outside the transaction's staging directory. The package manager is confined to it by `--prefix`, both npm configuration slots name empty files the desktop owns, and `--ignore-scripts` means no child survives to write elsewhere, so abandoning that child discards a candidate and leaves the promoted program directory untouched — the same end state as the crash recovery the runtime already implements for it, reached without waiting for the child's own 15-minute bound. Promotion itself is a pair of renames plus one atomic state write, which no cancellation attempts to interrupt.

The refused stages are the promotion gate: the candidate has already been fetched, and stopping between its judgement and its rename costs a wasted health check and buys no safety. There, the card's red control greys out, stays clickable, and answers with why it will not act, rather than dying silently.

A cancel request is confirmed before it is sent, and a cancel the runtime refuses is not presented as one that happened. The card can also be set aside while work continues, which returns the title bar controls it holds; a set-aside card still reappears with the transaction's result.

## Alternatives considered

**Parse the package manager's output for download progress.** npm's human-readable progress lines are not a protocol: they change with npm's own minor versions, the shipped arguments suppress them at the configured log level, and they carry no completion condition. A surface that mapped them to stages would look authoritative and be wrong at any time the package manager changed its wording, which is the failure mode the task forbids.

**Advance the stages on a timer.** A timed progression reports the passage of minutes, not work, and would show "installing" for a transaction that had already failed in the registry read. The card publishes exactly the stages the runtime reports and one terminal state per outcome, so no transition exists that is not caused by a step.

**Open a separate frameless window for the card.** A second `BrowserWindow` owns its own document, preload, IPC surface, packaging entry, and follow-the-parent geometry on resize and move. The title-bar chrome is already a desktop-owned renderer kept above both content surfaces with a pure, tested rectangle resolver behind it, so a new surface would duplicate all of that to reach the same layer.

**Kill the package manager in any stage the user asks.** The staging directory makes this survivable rather than destructive, but the promotion gate is where the transaction's evidence about a candidate lives, and the task's default is that installation and verification are not interrupted. Refusing there costs the user at most one bounded health check.

**Let the card block the window while an update runs.** The chrome surface protocol already has a full-content `dialog` state used for short confirmations, and reusing it would have taken the pointer away from the Harness for the length of an install. A card-sized rectangle instead keeps every other pixel of the window working, at the cost of the mode switch standing aside while the card is up.

**Show the card for a rollback too.** A rollback health-checks the retained version and swaps two state fields, so it has none of the stages the card draws and its dot row would light out of order. It keeps its existing behavior: the menu reports it busy and the native dialog reports its result.

## Consequences

The user who starts an update now sees a state within the same interaction, and a transaction that cannot be interrupted says so instead of appearing to hang. The card's claims are all things the runtime already knows, so the surface cannot outlive or contradict a transaction, and every path out of the running state is a settled outcome: promoted, failed, cancelled, or unchanged.

What it costs: the mode switch in the title bar stands aside while the card is up, because the card's rectangle is where those controls would otherwise be drawn and the card must not be coverable by a menu. Downloading and installing remain one reported step. A cancelled install gives up the bytes already fetched, and a cancel accepted during `preparing` while the registry round trip is still in flight is answered when that round trip is abandoned, not before it exists. The card covers install, update, and reinstall; the Harness tab's first-run setup button keeps its own path, so it still reports only a failure, and a rollback still reports through the native dialog.
