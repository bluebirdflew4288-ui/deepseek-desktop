# DeepSeek Desktop {{VERSION}}

## Download / 下载

- [macOS Apple Silicon — DMG（推荐）](https://github.com/bluebirdflew4288-ui/deepseek-desktop/releases/download/v{{VERSION}}/DeepSeek-Desktop-{{VERSION}}-mac-arm64.dmg)
- [macOS Apple Silicon — ZIP](https://github.com/bluebirdflew4288-ui/deepseek-desktop/releases/download/v{{VERSION}}/DeepSeek-Desktop-{{VERSION}}-mac-arm64.zip)

This release provides macOS Apple Silicon downloads. The Desktop shell uses Electron {{ELECTRON_VERSION}}, matching the validated local Mac runtime. Agent development tasks use local tools first, with Desktop node/npm/npx as fallback only when commands are absent. Harness itself uses the Desktop-controlled runtime. Harness updates download the official `@deepseek-ai/dsh` npm release; the legacy Cordis override applies only to Harness `0.1.5-rc.2`.

本次提供 macOS Apple Silicon 下载。Desktop 壳使用 Electron {{ELECTRON_VERSION}}，与已验收的本机 Mac 运行时一致。Agent 开发任务优先使用本机工具，Desktop node/npm/npx 仅在命令不存在时兜底；Harness 自身使用 Desktop 控制的运行时。Harness 更新下载官方 `@deepseek-ai/dsh` npm 发布包；旧 Cordis 覆盖仅针对 Harness `0.1.5-rc.2`。

- This is an unofficial community desktop application for DeepSeek.
- macOS Apple Silicon: ad hoc code signature only; no Developer ID distribution signature or notarization.
- Drag the app from the DMG to Applications. The included `安装指南.txt` describes first-launch Gatekeeper guidance.
- Windows x64: {{WINDOWS_SIGNING_DETAILS}}
- Application source commit: `{{APPLICATION_SOURCE_COMMIT}}`
- Release tooling commit: `{{RELEASE_TOOLING_COMMIT}}`
- Desktop App auto-update metadata is not published; install new Desktop versions from GitHub Releases.

## SHA-256 / 文件校验和

{{ASSET_HASHES}}

## 平台状态

- macOS Apple Silicon：仅使用 ad hoc 签名；没有 Developer ID 分发签名，也未公证。
- 将 DMG 内的 App 拖入“应用程序”。DMG 内含 `安装指南.txt`，说明首次打开可能遇到的 Gatekeeper 提示。
- Windows x64：{{WINDOWS_SIGNING_DETAILS_ZH}}
- 应用源码提交：`{{APPLICATION_SOURCE_COMMIT}}`
- 发布工具提交：`{{RELEASE_TOOLING_COMMIT}}`
- 不提供 Desktop App 自动更新元数据；请从 GitHub Releases 下载并安装新版 Desktop。
