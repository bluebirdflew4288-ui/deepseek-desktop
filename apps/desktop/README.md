# DeepSeek Desktop

English | [中文](README.zh.md)

The desktop app presents independent Chat and Harness modes in one native window. The system tray keeps their application lifecycle alive when the window is closed.

## Development

These commands require Node.js `^22.19.0` or `>=24.0.0` and pnpm `11.7.0`, and apply only to source development and packaging. A packaged application requires none of Node.js, npm, pnpm, Homebrew, or a global `dsh`: it carries Electron's runtime and a pinned npm runtime, and installs official Harness through Managed Runtime.

Install dependencies, then use the single desktop development command. It builds the Host and client packages, Web frontend, and Electron main process before launching the application:

```sh
pnpm run dev:desktop
```

Closing the window hides it. Use the tray menu to restore the window or quit the application. Explicit quit waits for the Host process to stop and escalates termination after the bounded Host grace period.

The desktop app accepts only the readiness URL emitted by `dsh web` for `127.0.0.1` or `localhost`. Navigation stays on that origin; HTTP and HTTPS links open in the system browser.

Build the Desktop artifacts before running the keyless Electron scenario. The scenario uses local Harness and Chat servers and never contacts the live DeepSeek website:

```sh
pnpm --filter @deepseek-ai/dsh-desktop run build
pnpm --filter @deepseek-ai/dsh-desktop run test:electron
```

## Modes and data

A new installation selects Harness. Later launches restore the last mode selected through the local title-bar switch. Both mode surfaces start below the existing 44px operating-system title bar, so the official Harness header and Chat controls never share pixels with traffic lights or the switcher. The content view consumes the remaining height and is resized from the same bounds on every window resize. Closed local chrome tightly wraps only the segmented switch and optional Chat actions. The Chat action menu or confirmation dialog appears only after the main process expands those bounds and acknowledges the applied layout. Harness starts independently, while Chat is created only after its first selection; switching modes retains both healthy views instead of reloading them.

The chrome view remains transparent. Its 164px segmented switch renders equal-width `Chat` and `Harness` choices; either segment selects its mode directly, with no mode menu, chevron, product mark, outer border, or compact abbreviation. The selected mode owns the shared `light`/`dark`/`system` preference, and Desktop applies that preference to the hidden mode. Harness uses its `ThemeRuntime` bridge, while Chat uses the versioned official theme preference and reloads only when an applied hidden preference changes that stored value. Local controls resolve `system` through Electron and render dark text on light content or light text on dark content. The isolated Chat preload also reports only a normalized opaque computed background color; the existing title-bar backdrop uses that color with a scheme fallback, while unsupported CSS values are rejected and the Chat menu and dialog keep opaque themed surfaces.

Harness keeps its existing sessions, workspace, agent configuration, and loopback Host. Chat displays the official website at `https://chat.deepseek.com/` and does not become a Harness model provider. A sandboxed, context-isolated preload accesses two validated official version-zero storage entries: it synchronizes `__appKit_@deepseek/chat_themePreference`, and before each Chat document initializes it changes only a retained `__appKit_@deepseek/chat_lastSessionValue.value.siderCollapsed` value from `true` to `false`. The sidebar therefore starts expanded after Chat creation or reload, while a retained Chat view preserves a later user collapse across mode switches. Missing or unknown sidebar storage remains untouched, sibling page settings are preserved, and the preload exposes no main-world API or DOM controls. Desktop does not read Chat cookies, credentials, conversations, network responses, or other website storage. An unknown theme-storage version disables theme synchronization without making Chat unavailable.

Chat uses the dedicated persistent Electron partition `persist:dsh-deepseek-chat`. Chromium retains that partition between application launches, including a login accepted by the live website. Chat and Harness do not share cookies, storage, prompts, attachments, conversations, credentials, or navigation state.

**Clear Chat Data** requires confirmation, closes the Chat view and its authentication windows, clears the partition's local storage and cache, and recreates Chat when it is selected. It signs the embedded site out when its authentication depends on that local data and deletes local Memory, but it does not delete conversations or account data stored on DeepSeek servers. Export Memory JSON first if the local records must be retained. Signing out through the website is the other way to end the embedded login.

### Chat Memory

Desktop loads the bundled DeepSeek++ Memory-only derivative into the same persistent Chat partition. Its fixed extension identity keeps the `DeepSeekPP` IndexedDB origin stable when the app is rebuilt or moved. On the first request of a new DeepSeek conversation, relevant local memories and the `memory_save` protocol are added to the outgoing Chat prompt. A model response can append a new record but cannot edit or delete existing Memory; those operations remain explicit actions in the local manager. The extension observes the official completion endpoint and uses the latest rendered message that is not confirmed as user only as a fallback for complete save calls. The fallback sends calls through the same append-only host operation and removes them from visible Markdown; confirmed user messages and reasoning blocks are excluded. Saving requires a short-lived completion authorization posted by the request hook for the current response and consumed by one accepted save. A role-less latest response can save only while that authorization is live; without it, technical tags may still be hidden but historical messages are never backfilled. An extension, host-page, database, or manager failure leaves Chat and Harness running.

Use the application or tray **Memory** menu to list, search, filter, add, edit, delete, or pin local records. **Export Memory JSON…** opens the system save dialog. **Import Memory JSON…** opens the system file dialog, validates the selected document, and commits all imported records in one IndexedDB transaction. Memory stays inside `persist:dsh-deepseek-chat`; Harness uses `defaultSession` and never loads the extension.

### Navigation and failures

Only the exact HTTPS origin `https://chat.deepseek.com` is currently trusted inside Chat. Same-origin new windows use the same restricted partition. An unrelated HTTPS new-window request opens in the system browser; a top-level escape is cancelled and offered through the local shell; unrelated redirects, malformed URLs, HTTP, and non-web protocols are blocked. A failed Chat view also offers the fixed official URL in the system browser. Authentication that needs another origin remains unsupported until that exact origin and flow pass release review and tests.

Harness remains limited to its validated loopback origin. User navigation and new-window requests to other HTTP or HTTPS origins open in the system browser, while external redirects and other protocols are blocked.

A Host startup failure, unexpected Host exit, or Harness renderer failure marks only Harness unavailable and offers a Harness retry. A Chat load, renderer, or responsiveness failure marks only Chat unavailable and offers Chat retry plus browser fallback. Clearing or retrying one mode does not clear or restart the other.

Native chrome follows the host platform. macOS uses a frameless inset title bar, traffic lights, and sidebar vibrancy; the switch sits immediately to the right of the traffic lights in that title bar. Windows retains its system frame, shadow, resize and Snap behavior, and Windows 11 rounded corners while a hidden title bar places the switch at the left and keeps native caption buttons at the far right. Closed local chrome ends with its actual controls, and the shell drag region starts after the largest closed control span, so native drag hit testing and transparent pixels do not intercept mode or website controls. Windows acrylic and macOS vibrancy reach only the sidebar, while conversation and details stay opaque. Linux keeps a frameless title bar and an opaque sidebar fallback.

## Packaging

The local packaging command performs the complete repository build, stages the pinned npm runtime used by Managed Harness, and creates an unpacked application for the current platform. The fixed Harness dependency closure is not packaged:

```sh
pnpm run package:desktop
```

Before Electron Builder runs, this command materializes the native Electron runtime for the current platform through Electron's checksummed installer. A clean installation therefore does not require a manually prewarmed Electron cache.

Packaged applications install and run the selected official `@deepseek-ai/dsh` version in a separate process through Electron's Node mode. The application therefore retains the supervised-Host lifecycle without shipping a second Node executable or a fixed Harness closure. The pinned npm runtime is verified before packaging and by an `afterPack` check. Both macOS and Windows use the exact tracked `apps/desktop/build/icon.png` source; the repository does not preprocess or commit platform-specific icon variants.

### Automated GitHub releases

Pushing a `vX.Y.Z` tag whose version matches `apps/desktop/package.json` starts `.github/workflows/desktop-release.yml`. Separate native runners build unsigned macOS Apple Silicon DMG/ZIP and Windows x64 NSIS/ZIP files; the workflow creates or updates the matching GitHub Release only after both builds succeed. A version mismatch or missing artifact fails the workflow before publication.

### Signed macOS DMG

The macOS distribution command requires a valid `Developer ID Application` identity whose certificate and private key are both installed in the build user's Keychain. It also requires one complete notarization credential source. A Keychain profile keeps the app-specific password out of the repository and shell history:

```sh
xcrun notarytool store-credentials "dsh-notary" --apple-id "<Apple ID>" --team-id "<Team ID>"
```

`notarytool` requests the secret interactively. Build the signed, hardened-runtime, notarized DMG with the stored profile:

```sh
APPLE_KEYCHAIN_PROFILE=dsh-notary pnpm run dist:mac:desktop
```

An existing secrets file can supply `MAC_CERT_P12_BASE64`, `MACOS_SIGN_IDENTITY`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` without importing the certificate into the persistent Keychain:

```sh
node --env-file=/absolute/path/to/macos-signing-secrets.env --import tsx apps/desktop/scripts/release-mac.ts
```

Electron Builder imports that Base64 PKCS#12 certificate into its temporary Keychain and removes it when the build finishes. The wrapper keeps signing and notarization variables out of the repository-build and runtime-staging subprocesses, then passes them only to Electron Builder. The secrets file and its path are never tracked.

The release preflight runs before the repository build. It fails if the host is not macOS, the supplied identity is not a `Developer ID Application` identity, signing credentials are incomplete, signing discovery is disabled, or notarization credentials are missing or incomplete. Without the PKCS#12 group, it requires a usable `Developer ID Application` identity and private key in the Keychain. Instead of a Keychain profile, the command accepts the complete Apple ID group (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`) or App Store Connect API key group (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`).

After a successful build, mount the generated DMG and verify the installed application signature, Gatekeeper assessment, and stapled notarization ticket:

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

## Known limitations

The first desktop assembly uses a loopback HTTP Host. The renderer and Host protocol remain unchanged so the application can replace the transport with the IPC carrier reserved by the GUI architecture without changing product features.

GitHub Actions publishes unsigned macOS and Windows installers. The credential-backed signed installer path currently targets macOS; Windows signing and Linux release packaging remain release work.

The local Electron scenario verifies Desktop lifecycle and storage policy, not compatibility with the live DeepSeek website. DeepSeek can change authentication origins, WAF behavior, page requirements, or embedding policy independently. No login method is release-qualified until the following smoke procedure passes on both macOS and Windows:

1. Complete the login method in embedded Chat and record every top-level authentication origin.
2. Restart Desktop and verify the login persists; switch to Harness and back and verify the Chat page state remains.
3. Verify same-origin authentication windows, external HTTPS links, explicit Chat reload, and browser fallback.
4. Clear Chat data and verify the embedded login is removed without changing Harness data.
5. Exercise Chat load or WAF failure and Host failure, verifying the other mode remains usable.

Public distribution also requires a separate review of DeepSeek's current service terms and branding rules. This repository records no permission to redistribute or embed the website.

## Model Experience

The desktop shell and selected-mode state do not add model-visible input. On a new Chat conversation, the Memory-only extension adds selected local Memory and its narrow tool protocol to the outgoing official Chat request. The reused Web profile owns that context and persistence; Chat content and Memory never enter Harness prompts, session events, or telemetry.

Managed installs compare the installed package-lock integrity with the resolved official release before promotion. Replacing an existing version retains a recovery directory until the version state commits; interrupted replacements restore it. Managed Node children exit when their Desktop parent dies. Orphan termination requires the derived managed CLI path, the expected command, and a per-launch identity in the live process environment; legacy or mismatched records cannot authorize a signal.
