# Agent Note: Desktop owns Harness runtime and supplements local development paths

Status: implemented

English | [中文](2026-10-02-desktop-hybrid-development-environment.zh.md)

## Problem

GUI launches miss development paths exported by a user's login shell. Inheriting the complete Desktop environment also lets Node startup hooks alter the managed Host, even though its executable is fixed. Agents need basic Node commands without requiring a separate system Node installation.

## Decision

Desktop builds a daily Host environment without mutating Electron process.env. A bounded, cancellable POSIX login-shell probe exports only PATH and seven SDK path variables; Windows uses its inherited environment. User development paths retain their order; missing inherited/system directories follow, and packaged Desktop fallback commands come last. Commands resolve independently without retries after execution failures or version mismatches. Relative/empty PATH entries are rejected. Startup hooks and internal namespaces are removed; Desktop restores its selected DSH_HOME, launch identity and Electron Node mode, then adds the parent watchdog. Electron Node invocations preload a Desktop bootstrap that removes ELECTRON_RUN_AS_NODE before application code; ordinary tasks, npm lifecycle scripts and npx commands inherit no mode flag. Public child_process APIs retain Node mode and the same preload only when directly reusing process.execPath without a shell, including Harness internal runners and fork; external executables keep their own launch mode. The bootstrap does not edit the installed Harness or bundled npm. NODE_EXTRA_CA_CERTS, NODE_USE_SYSTEM_CA, NODE_USE_ENV_PROXY and ordinary proxy/locale settings survive; NODE_TLS_REJECT_UNAUTHORIZED does not.

Relocatable node/npm/npx shell launchers reuse the Electron executable and the already bundled npm CLI closure. They preserve arguments, cwd and exit status and select Electron Node mode. Fallback npm/npx run under Electron while lifecycle scripts resolve node through the task PATH. Project npm keeps ordinary npmrc, registry and cache behavior; global installs default to HOME/.local on POSIX or APPDATA/npm (USERPROFILE/.local when APPDATA is absent) on Windows. Existing PREFIX and explicit npm configuration override that default. The default global command directory follows user/system paths and precedes fallback launchers; custom prefixes require their own PATH setting. Windows provides cmd/PowerShell launchers; shell-free CreateProcess users need an actual executable or process.execPath. Desktop bundles no Git, language SDK or system package manager.

Maintenance remains governed by the [managed Harness design](../../proposed/architecture/2026-09-10-managed-harness-runtime.md): isolated process environment, bundled npm, controlled registry/config/cache and disposable health home. That note's version transactions and ownership rules remain independently applicable; this decision adds daily task discovery and commands rather than superseding maintenance. Chat receives no discovery environment or launcher. Source development retains DSH_DESKTOP_NODE_EXECUTABLE or PATH node, adds no packaged fallback directory and requires no staged npm.

The probe follows the framing, account-shell and fallback mechanisms of [official Desktop](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/apps/desktop/src/login-shell-environment.ts), with a total deadline, bounded output, filtering and group cleanup. It does not copy the upstream whole-environment overlay.

## Alternatives considered

**Inherited GUI environment only.** It preserves startup speed but misses common Homebrew and version-manager installations.

**Complete login-shell overlay.** It restores Terminal-like configuration but admits Node hooks, internal overrides and unrelated shell exports into Host startup.

**Desktop-first development commands or a Node toolchain manager.** These override user choices or add version-selection responsibilities; independent PATH fallback preserves existing commands and exposes their failures.

**Separate Node or bundled development toolchains.** These enlarge distribution, signing and update responsibilities; Electron and existing npm already provide the required basic Node capability.

## Consequences

Local node/npm/npx take precedence. Mixed sources are allowed, including local Node with fallback npm; Desktop does not silently repair incompatible or broken local commands. Host startup does not inherit NODE_OPTIONS or NODE_PATH. Local development tools can use runtime hooks provided explicitly by a task; Desktop fallback node/npm/npx clear NODE_OPTIONS and NODE_PATH to prevent external startup hooks from altering Electron Node startup. Login-shell rc code executes during discovery and may have its own side effects; Desktop never edits those files. Discovery failure falls back to inherited paths and does not block maintenance or Chat. The environment is discovered once per Desktop launch: additions inside existing PATH directories are visible immediately, while new directories require restarting Desktop or an explicit task environment; restarting only Harness does not repeat discovery. Windows native command interoperability and Linux packaging need native-platform acceptance; advanced MSVC environment activation is outside this decision.

## Verification

Parser/process tests cover framed output, failure fallback, timeout, cancellation and group cleanup. Environment tests pin variable ownership, SDK filtering, PATH order/aliases and maintenance separation. Real command tests prove local priority, visible failures, Node fallback, mixed lifecycle scripts, user global installs, npm configuration and relocation. A runnable keyless Host fixture assembles the real Harness shell/subprocess providers and snapshots its task transcript. Packaging verifies all launchers against the packaged Electron executable and pinned npm/npx versions.
