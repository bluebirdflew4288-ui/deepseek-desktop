# Agent Note: 标签驱动的桌面 GitHub 发布

Status: implemented

[English](2026-08-17-tag-driven-desktop-github-releases.md) | 中文

## 问题

桌面应用已有本地打包命令，但仓库没有生成可下载 macOS 和 Windows 应用的工作流。既有发布工作流分别发布 NPM、Python、vendored 和 native 包族；扩展其中任何一个都会把桌面产物与另一条版本线和发布目的地绑定在一起。

桌面发布还需要在目标平台原生暂存运行时。单一宿主可以交叉打包部分 Electron shell，但不能证明已暂存的 Host 依赖树与目标操作系统和架构一致。

## 决策

`.github/workflows/desktop-release.yml` 负责桌面 GitHub Releases。推送 `vX.Y.Z` 标签后，工作流先确认标签与 `apps/desktop/package.json` 精确一致，且标签提交位于 `origin/main` 历史中，再启动原生 macOS Apple Silicon 与 Windows x64 构建。每个任务都会执行不可变安装、确认 runner 架构、构建仓库、暂存固定版本的 npm 运行时，并生成只列出声明产物的清单。Desktop 仍为 `1.0.5`；工作流不会修改版本号。

macOS Apple Silicon 任务生成仅带 ad hoc 签名的 DMG 与 ZIP；它们没有 Developer ID 分发签名，也未公证。Windows x64 任务在运行 Electron Builder 前，要求提供 PFX、密码、预期完整证书 Subject 和 RFC 3161 时间戳服务器。`forceCodeSigning` 会让缺少签名时构建失败。上传前，Authenticode 校验会检查安装程序和封装后的应用可执行文件：要求可信证书链有效、完整 Subject 精确匹配、时间戳证书包含 time-stamping EKU，并且 `signtool verify /pa /all /v` 成功。PFX 与密码只在该构建步骤可用，不会进入产物或日志。

每个平台上传一份清单以及清单声明的 DMG/ZIP 或 NSIS/ZIP 文件。工作流不生成或上传更新元数据。Release 任务获得 `contents: write`，构建任务保持只读仓库权限。它会先创建 draft，再按 SHA-256 对照四个清单产物；同名且哈希相同的文件会跳过，同名但哈希不同则失败。工作流绝不使用 `--clobber`，清单之外的既有资产保持不变；校验哈希与来源提交后才发布 draft。已发布的 Release 仅在来源提交及所有声明哈希都吻合时视为无操作；缺失或不同的资产会导致安全失败。

桌面包携带独立的 `1.0.5` 应用版本。它不会改变 Harness NPM 包族共享的预发布版本；该包族的 `dsh-v*` 标签和注册表发布仍然独立。

工作流不会声称 macOS 产物已完成 Developer ID 签名或公证。目前尚未配置 Windows 发布签名凭据、预期 Publisher 和时间戳设置，因此 Windows 任务会在生成发布产物前按设计失败。未签名的 Windows 1.0.5 本地试用版不是发布候选。

## 曾考虑的替代方案

**在一个 runner 上构建两个平台。** Electron Builder 可以交叉打包部分目标，但已暂存运行时包含按平台选择的依赖。原生 runner 让安装、暂存和打包处在同一操作系统和架构上。

**只发布未封装的应用目录。** 目录适合本地验证，但不便作为 GitHub Release 下载。DMG、NSIS 和 ZIP 同时覆盖安装与便携检查，又无需提交生成输出。

**凭据配置前先发布未签名 Windows 版本。** 不采纳，因为未签名安装程序无法确认预期 Publisher，可能误导用户。可信签名输入配置完成前，工作流会阻止发布。

## 后果

标签必须与桌面包版本一致并位于 `main` 历史中。任一平台失败都会阻止发布，因此 Release 总是包含两个声明目标。macOS 仍是 ad hoc 签名且未公证；Windows 必须通过可信 Authenticode 与时间戳验证。Windows 签名密钥只对一个构建步骤可见，Release 修改权限仍隔离在 Release 任务中。
