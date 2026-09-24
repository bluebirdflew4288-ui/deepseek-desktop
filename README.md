# DeepSeek Desktop

English | [中文](README.zh.md)

An integrated community desktop experience for official DeepSeek Chat, local Chat Memory, and DeepSeek Harness.

**Unofficial project.** This is an unofficial, community-maintained DeepSeek Desktop project. It is not affiliated with, endorsed by, sponsored by, or an official product of DeepSeek AI. It builds upon open-source components from DeepSeek and the broader community. All trademarks, upstream project names, and copyrights remain the property of their respective owners. Open-source licenses permit use under their terms; they do not imply an official partnership or endorsement.

## Preview

### Chat

![DeepSeek Desktop — Chat](assets/screenshots/chat-mode-current.png)

### Harness

![DeepSeek Desktop — Harness](assets/screenshots/harness-mode-current.png)

Current macOS Apple Silicon build. The `*-mode-home.png` files under `assets/screenshots/` are inherited upstream illustrations and do not show this build.

## Features

- Chinese and English desktop controls with retained Chat and Harness views.
- Official DeepSeek Chat with a dedicated persistent browser partition.
- Local Chat Memory and a Memory Manager for search, add, edit, delete, pin, and JSON import/export.
- Official DeepSeek Harness WebUI, without a fork of its published frontend.
- Managed Harness installation, launch, health checks, and manual update checks.
- Desktop notifications for Chat and Harness results, and an update card that reports the real stages of a Harness transaction.
- Current and previous program versions, rollback, interrupted-operation recovery, and process ownership checks.
- Packaged runtime capability that does not require users to preinstall Node.js or npm.

## Architecture overview

| Component | Role |
| --- | --- |
| Desktop runtime | Electron's Node mode plus pinned npm 11.12.1 installs and supervises Harness. |
| Chat | The official website in its own persistent Electron partition. |
| Local Memory | A modified Memory-only DeepSeek++ extension in the Chat partition. |
| Harness | Official `@deepseek-ai/dsh`, installed independently of the Desktop release. |
| User data | Chat/Memory storage and Harness settings/sessions remain separate from managed program versions. |

The packaged app includes the runtime capability needed to install and manage official Harness. It does **not** bundle a fixed Harness dependency tree. Source development uses the checkout's Harness implementation; packaged operation downloads the official npm package. See [the desktop guide](apps/desktop/README.md) for implementation details.

## DeepSeek Chat

Chat opens [chat.deepseek.com](https://chat.deepseek.com/) and uses the website's own login. Website access, authentication, network connectivity, and service policies remain under DeepSeek's control. A Chat login does not provide Harness API credentials.

## Local Memory

Memory records live locally in the Chat partition. On a new conversation, selected relevant records and the Memory save protocol are added to the outgoing Chat prompt; the model can append records through that protocol. Manage existing records through the **Memory** menu. Export JSON before clearing Chat data or moving profiles.

Local storage does not mean all Memory stays offline: selected Memory included in a prompt is sent to DeepSeek with that Chat request. Exported JSON contains the exported records and should be treated as private data. Desktop does not promise encryption of Memory at rest. **Clear Chat Data** also deletes local Memory and embedded login state; it does not delete server-side DeepSeek conversations.

## Harness

Harness presents the official WebUI and its workspace, agent, and tool capabilities. Configure the provider credentials it requires separately from Chat. Harness runs local tools with the permissions of its process and configured policies; review commands and workspace access before use.

## Managed Harness Runtime

On a packaged first run, select Harness and choose **Install Harness**. Desktop downloads official `@deepseek-ai/dsh` through pinned npm from the official registry, checks installation integrity and health, then promotes the version. Network access is required for installation and updates. Normal startup launches the installed version without scheduling update checks.

## Update and rollback

Use the **Harness** menu to check for updates and explicitly install the official `latest`. Prerelease tags such as `next` are not substituted for `latest`. An update becomes current only after health checks; failures preserve the current version. Desktop retains current and previous program versions. **Advanced → Roll Back** requires a retained previous version that passes health checks.

Installing, updating, or reinstalling shows a card in the window while the transaction runs. It reports the stage the runtime actually reached — preparing, installing, verifying, or the candidate health check — and shows no inferred percentage, while Chat and Harness stay usable underneath it. Cancel is offered while the transaction has written nothing outside its staging directory, and is refused once the candidate is being promoted; a refused control stays clickable and says why. A completed card names an outgoing version only when the version in use actually moved, so a reinstall of the version already running is not shown as an upgrade, and it states that the promoted version applies once the Harness restarts.

Recovery handles interrupted program transactions. Harness rollback currently restores the selected Harness binary/version only; it does not roll back or restore local Harness-managed data under `~/.dsh`. If a newer Harness version migrates or changes the local data format, an older Harness version may not be able to read that state after rollback. Until the upstream schema and migration behavior are verified, DeepSeek Desktop does not guarantee cross-version data compatibility after rollback. Rollback is not a backup; back up valuable Harness data before changing versions.

## Installation

Human acceptance covers the macOS Apple Silicon development build. There is no stable public release of this derivative yet. The release workflow requires a trusted Windows x64 Authenticode certificate and blocks unless both the installer and application executable have a valid chain, the configured full certificate Subject matches exactly, and a trusted RFC 3161 timestamp is present. Those Windows signing credentials are not configured, so a release currently fails closed. macOS release artifacts use an ad hoc signature only; they are not Developer ID signed or notarized. The user accepted the earlier unsigned Windows x64 1.0.5 local trial build, including its native menus, tray behavior, and notifications; that acceptance applies only to that installed build. The latest source passed `pnpm run build`. Two isolated packaging preflights on 2026-09-24 failed in `resEdit` with `EBUSY`; after moving Windows npm execution out of `afterPack`, a full Windows x64 NSIS/ZIP build and packaged npm-runtime verification passed on 2026-09-25. The resulting installer and application executable are `NotSigned`: there is no trusted signing certificate, formal signature, or GitHub Release. The current source package has not been installed, and its application startup, Harness, and Chat have not been verified. Linux Desktop packages are not a current release target.

### Packaged users

A packaged DeepSeek Desktop requires no preinstalled Node.js, npm, pnpm, or Homebrew, and no globally installed `dsh`. The packaged app runs its runtime through Electron's Node mode plus a pinned npm runtime inside the package, and installs the official `@deepseek-ai/dsh` package through Managed Runtime the first time Harness is used. Harness still needs the account or API credentials required by whichever model provider it is configured to use.

### Source development requirements

The Node.js `^22.19.0` or `>=24.0.0` and pnpm `11.7.0` requirements apply only to developing from source, building, and packaging. They are not prerequisites for using a packaged app.

<a id="run"></a><a id="run-from-source"></a>

```sh
pnpm install
pnpm run dev:desktop
```

To produce a local unpacked application:

```sh
pnpm run package:desktop
```

The package command stages pinned npm and builds the Desktop app. It does not publish a release. See [the desktop guide](apps/desktop/README.md) for packaging details.

## Basic usage

1. Open Desktop and choose **Chat** or **Harness** in the title bar.
2. Sign in through the official Chat page, or install Harness and configure its provider separately.
3. Open **Memory → Manage Memory** to inspect or add local records; use JSON export for a backup.
4. Use the Harness menu for explicit update checks, restart, and eligible rollback.
5. On macOS, Command+W hides the window; reactivate the app to restore it. Command+Q exits Desktop and its owned managed processes.
6. On Windows, F10 opens the application menu. Closing the window or pressing Alt+F4 hides it; click the tray icon to restore it, including from a minimized state. Use the tray's Quit command to exit.

## Data, privacy, and runtime isolation

Chat cookies and local Memory belong to the Chat partition. Harness uses its own home, normally `~/.dsh`, or an explicitly configured `DSH_HOME`; existing Harness configuration may be shared with a separately launched CLI. Managed program versions, staging, and npm cache live under Desktop's user-data directory. Updating program files does not intentionally migrate or delete Harness user data.

Chat Memory is not injected into Harness prompts. Ownership checks prevent stale or mismatched process records from authorizing termination of an unrelated `dsh`. This is program/runtime isolation, **not a complete OS-level sandbox**. The configured Harness and its tools can access local resources. Do not include cookies, API keys, private Memory, or session exports in bug reports; see [SECURITY.md](SECURITY.md).

## Upstream and acknowledgements

This project builds upon the open-source [deepseek-desktop](https://github.com/zcx960/deepseek-desktop) project by **@zcx960**. We thank the original author for the Desktop foundation. This derivative adds local Chat Memory and Managed Harness installation, update/rollback, recovery, and acceptance work while retaining upstream localization and desktop integration improvements.

Thanks also to [DeepSeek AI / DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), [DeepSeek++ / deepseek-pp](https://github.com/zhu1090093659/deepseek-pp), and the Cordis, Electron, Node.js, npm, and other dependency contributors. [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md) records the used revisions and license locations. Attribution does not claim joint development, author participation, or approval of this derivative.

## Development status

Engineering seal: **READY FOR HUMAN ACCEPTANCE**. **Human Acceptance: PASS**, as reported by the project owner for macOS window lifecycle, layout, Chat, local Memory, Memory Manager, and adding Memory. Public release preparation is in progress. Product development for this acceptance stage is complete.

A real GUI update-to-rollback run remains an upstream follow-up: at sealing, official `latest` equaled the installed version. Packaged update/rollback safety checks passed; the unavailable GUI sequence is not represented as executed. The owner's acceptance report does not separately claim an import/export GUI transcript.

## Known limitations

Cold Harness installation depends on registry availability and may take several minutes. Future official releases can change startup, authentication, or storage behavior. Desktop's theme entry governs the Desktop shell and Chat. The official Harness WebUI keeps its own `light`/`dark`/`system` setting and cannot reliably follow the Desktop theme entry; this is an accepted architectural boundary, because no stable official theme-control interface exists to depend on and forcing parity would require coupling to Harness internals or forking its official frontend. If a future official release exposes a stable external theme-control interface, a unified entry can be re-evaluated. Chat embedding can be affected by website policy, WAF, or authentication-origin changes. This project supplies no official service authorization and no stable-release or cross-platform certification.

## License

The existing [MIT License](LICENSE), including its upstream copyright notice, remains in place for the MIT-covered code. The Memory derivative is **Apache-2.0**, native Landlock components are **BSD-3-Clause**, and bundled npm is **Artistic-2.0** with dependencies under their own terms. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md). These components are not relicensed by the root MIT file.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing changes. Keep product fixes focused, preserve upstream attribution, and test only with disposable data. Publishing a Desktop binary, tag, or release is a separate maintainer decision.
