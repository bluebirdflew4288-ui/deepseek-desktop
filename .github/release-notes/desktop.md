# DeepSeek Desktop {{VERSION}}

macOS Apple Silicon and Windows x64 desktop artifacts are listed below with SHA-256 hashes.

- macOS Apple Silicon: ad hoc code signature only; no Developer ID distribution signature or notarization.
- Windows x64: Authenticode-signed installer and application executable; the trusted certificate chain, exact publisher Subject, and RFC 3161 timestamp are verified before release.
- Source commit: `{{COMMIT}}`
- Desktop auto-update metadata is not published by this workflow.

## 文件校验和

{{ASSET_HASHES}}

## 平台状态

- macOS Apple Silicon：仅使用 ad hoc 代码签名；未使用 Developer ID 分发签名，也未公证。
- Windows x64：安装程序与应用可执行文件均通过 Authenticode 签名；发布前验证可信证书链、完整 Publisher Subject 精确匹配和 RFC 3161 时间戳。
- 来源提交：`{{COMMIT}}`
- 此工作流不发布 Desktop 自动更新元数据。
