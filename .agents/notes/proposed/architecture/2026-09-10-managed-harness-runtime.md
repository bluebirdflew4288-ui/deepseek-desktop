# Agent Note: Managed Harness Runtime owns the official Harness version

Status: proposed

English | [中文](2026-09-10-managed-harness-runtime.zh.md)

## Problem

The packaged desktop ships one fixed Harness version. `apps/desktop/scripts/stage-runtime.ts` materializes the whole `@deepseek-ai/dsh` dependency closure into `apps/desktop/runtime-host`, Electron Builder copies it to `resources/host`, and the supervisor starts `resources/host/node_modules/@deepseek-ai/dsh/lib/bin.js`. Every official Harness release therefore requires rebuilding and republishing the entire desktop application, and the desktop shell version and the Harness version cannot move independently.

The published Harness has also moved past what the staged closure does. The checkout stages `0.1.0-rc.5`; the official registry's `latest` tag names `0.1.5-rc.1`. The two disagree on the contracts the supervisor depends on: `0.1.5-rc.1` emits `dsh web: http://127.0.0.1:<port>/?token=<launch-token>` where `0.1.0-rc.5` emits a bare origin, it authenticates the browser with a launch token exchanged for an authority-bound signed cookie instead of the `apiToken` bearer this checkout adds in `packages/client/connection/src/api-token.ts`, and it registers `--no-open` because `openBrowser` defaults to handing the Web UI to the user's default browser. A supervisor that installs the official package must speak the official contract, not the staged one.

## Proposal

`apps/desktop/src/managed-harness*.ts` is the desktop-managed Harness program directory. It installs the official `@deepseek-ai/dsh` from the official npm registry into a directory the desktop owns, retains exactly two program versions, and repoints which one the Harness tab launches. Harness *user* data is not part of it: the CLI resolves its own home (`~/.dsh`, overridable with `$DSH_HOME`) and holds settings, credentials, sessions, profiles, storages, and attachments there, so no transaction in this module reads, moves, copies, or deletes it, and no version switch needs a migration.

The execution environment is the Electron binary's own Node, started with `ELECTRON_RUN_AS_NODE=1` and `--expose-internals`. Electron 43.4.0 carries Node 24.18.1, which satisfies the effective engine floor `>=22.19.0` that `@earendil-works/pi-ai` declares transitively, and `--expose-internals` is what the vendored Cordis loader needs to reach `internal/modules/esm/loader`. Shipping a second Node executable would add roughly 180 MB and a signing surface without changing any of that.

The installer runs the npm CLI the desktop ships, under the same Electron Node, with a pinned `--registry https://registry.npmjs.org/` and both configuration slots pointed at empty files the desktop owns, so neither a personal registry mirror nor a relaxed integrity setting can reach a managed install. It resolves peers by npm's default rules and skips install scripts. Both choices are load-bearing: `--legacy-peer-deps` omits the 24 Service Definition packages the Harness closure declares as peers, and the CLI fails to boot without them, while every native module in the closure (`node-pty`, `sharp`) ships a prebuilt binary so no script needs to run. The environment is explicit rather than inherited, and its `PATH` names only operating-system directories, so a managed install cannot resolve a Node, npm, or npx the user installed.

Only the official `latest` distribution tag is read. Prerelease channels are not consulted, so an alpha or nightly build is never offered as an update, and nothing checks the registry on a schedule: reading it is a user action.

A transaction stages into `staging/<version>`, verifies the installed manifest names the package and version it asked for, health-checks the candidate by launching it with the production arguments against a Harness home under `staging/`, renames the directory into `versions/<version>`, and only then writes the state that names it. The directory is durable before the state points at it, so a crash between the two leaves the previous version promoted and the candidate unreferenced, where collection removes it. Promotion makes the outgoing current the rollback target and collects anything older, so the program tree holds two versions and cannot accumulate. A rollback health-checks the target first and keeps the current version promoted when that check fails. Rollback moves program files only; there is no user-data snapshot and nothing to restore.

The version state is one atomic document naming `current`, `previous`, and an in-flight `pending` transaction. An unrecognized document is reported as unusable rather than guessed at, and a `pending` marker at startup means the transaction never completed, so recovery discards that candidate and keeps the last verified version.

Process ownership needs more than a process identifier. The supervisor holds the child handle it spawned, so ordinary stopping is direct. For a Harness an earlier crashed launch may still own, recovery reads the recorded identifier's live command line and signals it only when the derived managed CLI command and the per-launch identity in the live process environment both match. A Harness the user started, one belonging to another desktop instance, and any unrelated process reusing the identifier all fail that check and are left running. The Harness binds loopback on an operating-system-assigned port, so it never contends for a port another process holds, and nothing kills by port or by name.

The readiness parser accepts the official `?token=` query and surfaces the launch token, which the Harness surface carries into the first document load so the Host can exchange it for its cookie. `searchParams.set` keeps the token single, because the Host rejects a handoff URL carrying it twice. The token is process-scoped: it is never persisted, logged, or reused across launches, and the diagnostics log records only operation facts, so no credential can enter it. A Host that mints no token still authenticates through the spawn-environment bearer, and the surface attaches that bearer only when there is no token, so the two models do not overlap. The supervisor's shutdown grace is 8s, strictly above the CLI's own 5s force-exit timer, so escalation cannot race a child still completing its teardown.

The candidate packages shell resources and pinned npm 11.12.1, with no `resources/host` closure. A missing promoted managed version displays setup. The npm pin records official registry provenance, tarball integrity, and license; packaging verifies its contents and executable entry.

Resolved release integrity is compared with the installed lock entry before promotion. A replacement keeps the retained directory in `replacement-backup` until the atomic version-state commit, so either rename checkpoint can recover the original. A random per-launch identity and the derived CLI command prevent a reused PID or a substituted record from authorizing a signal. Parent-death watchdogs prevent installer and Harness children from surviving Desktop; recovery additionally probes live installer identities before reclaiming staging and rejects truncated or failed probes.

## Alternatives considered

**Ship a standalone Node.js runtime.** Roughly 180 MB, a second Mach-O to sign, and no capability the Electron binary does not already provide at a version above the engine floor.

**Keep bundling a fixed Harness version and update the whole app.** This is the coupling the decision removes.

**Hand-roll a registry installer.** Resolving 521 packages means owning semver ranges, peer and optional dependencies, platform filters, and integrity checking. The closure's peer declarations are exactly what a naive resolver gets wrong, and getting it wrong produces a tree that fails at boot rather than at install.

**`--legacy-peer-deps` for install speed.** Verified to omit 24 peer packages; the CLI then fails with `ERR_MODULE_NOT_FOUND` for `@deepseek-ai/cordis-plugin-group`.

**Fork the official Web UI to keep this checkout's desktop embedding.** The published `@deepseek-ai/dsh-web-frontend` carries no `data-dsh-desktop-embedded` styling and no desktop theme bridge, so the official Web UI renders in its browser form inside the Harness tab. Re-adding that would mean maintaining a fork of the official frontend against every release, which is the coupling this decision removes. The desktop still sends `dsh-desktop-platform` and `dsh-desktop-embedded`, so an official frontend that grows support picks them up unchanged.

**Point `$DSH_HOME` at a desktop-managed directory for hermeticity.** It would isolate the Harness from the user's third-party profile plugins, and it would orphan the settings, credentials, and sessions the user already has. Isolation belongs in tests, which set `$DSH_HOME` per run; the product uses the home the CLI resolves.

## Verification so far

Unit and integration coverage in `apps/desktop/tests/managed-harness.spec.ts` exercises first install, up-to-date short-circuits, registry-only update checks with no startup or scheduled lookup, promotion, retention of exactly two versions, collection of unreferenced versions and staging, install failure, substituted-version failure, health-check failure, unreachable registry, rollback, rollback with an unhealthy target, rollback with no target, reinstall, crash recovery from a pending marker, an unusable state document, installer arguments and environment, health-check isolation of `$DSH_HOME`, log rotation, and the three ownership cases. `host-supervisor.spec.ts` pins the token readiness contract and the `--no-open` opt-in; `harness-surface.spec.ts` pins that a token-carrying Host loads the token once and leaves the bearer unattached.

Empirically verified against the real published package before the design was fixed: `npm install @deepseek-ai/dsh@latest` with default peers and `--ignore-scripts` produces a complete 521-package tree; that tree starts under `ELECTRON_RUN_AS_NODE=1` with `--expose-internals`, binds only `127.0.0.1` on an assigned port, and reaches readiness in roughly 10s; `GET /` without the token answers 401, with it answers 303 and sets an `HttpOnly; SameSite=Strict` cookie, and the cookie serves the real 27 KB Web UI; the desktop's own query parameters coexist with the token while a duplicated token is rejected; `SIGTERM` releases the port within seconds; and the user's real `~/.dsh` is untouched throughout.

## Acceptance criteria

This note moves to `implemented/` when a packaged macOS arm64 build, carrying the staged npm CLI and no `resources/host` closure, demonstrates all of the following on the real application rather than in a fixture:

- First run shows the Harness tab's setup state, and one user action installs the official `latest` release and serves its Web UI, with Chat working independently throughout.
- An existing managed version launches after a full application restart, against the user's real Harness home, with existing settings, credentials, and sessions intact.
- A manual update check reports the official `latest` version, and nothing queries the registry at startup or on a schedule.
- A successful update promotes the new version, retains the outgoing one as the rollback target, and collects anything older; a failed update, a substituted version, and a failed health check all leave the outgoing version launchable.
- A rollback restores the retained version and swaps the retention; a rollback target that fails its health check leaves the current version promoted.
- An interrupted transaction recovers on the next launch to the last verified version, with no half-switched state and no staging residue.
- The Harness binds only loopback, a Harness the user started themselves is never signalled, and an occupied port is handled without killing anything.
- `Command+W` still hides without quitting and `Command+Q` still stops the owned Harness child, leaving no owned orphan.
- Chat and Local Memory are unchanged, the Harness session carries no Memory extension, and the Memory source/package resource tree still compares `MATCH` after repackaging.
- The staged npm CLI's license and version are disclosed in the regenerated `THIRD_PARTY_NOTICES.md`, and no launch token, bearer, cookie, or credential appears in the repository, the diagnostics log, or the version state.

## Risks

**The official contract can move again.** This checkout is `0.1.0-rc.5` and the registry's `latest` is `0.1.5-rc.1`, and the two already disagree on the readiness URL, the authentication model, and browser handoff. A later release could change the readiness line, the token exchange, or the `--no-open` flag. The health check is the containment: a version that cannot boot and serve is never promoted, so a contract break costs a failed update rather than a broken Harness.

**A cold install is slow on a constrained network.** Resolution alone fetched 521 packages, and one packument took 201s behind a transparent proxy that reset connections. The bound is 15 minutes with a clear failure, but a first install on such a network may look stalled to the user.

**The official Web UI is not desktop-integrated.** The published frontend carries no desktop embedding styles and no theme bridge, so the Harness tab renders in its browser form and the desktop's explicit theme preference does not reach it. This is a visible product change from the staged closure, accepted here rather than solved.

**A shared Harness home means shared configuration.** `~/.dsh/cordis.patch.yml` and `~/.dsh/profiles/web/cordis.patch.yml` are user-owned, outrank the profile layer, and are hot-reloaded for the web profile. Either can rebind the webserver host or suppress the readiness line under a managed launch. The parser rejects a non-loopback readiness URL, so rebinding fails the launch loudly rather than exposing the Harness.

**Two program versions cost roughly 578 MB.** Retention is bounded and collection is verified, but the floor is two full dependency closures, and a user on a small volume will notice.
