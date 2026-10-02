# Agent Note: 标签驱动的桌面 GitHub 发布

Status: implemented

[English](2026-08-17-tag-driven-desktop-github-releases.md) | 中文

## 问题

桌面应用已有本地打包命令，但仓库没有生成可下载 macOS 和 Windows 应用的工作流。既有发布工作流分别发布 NPM、Python、vendored 和 native 包族；扩展其中任何一个都会把桌面产物与另一条版本线和发布目的地绑定在一起。

桌面发布还需要在目标平台原生暂存运行时。单一宿主可以交叉打包部分 Electron shell，但不能证明已暂存的 Host 依赖树与目标操作系统和架构一致。

## 决策

[Desktop Release 工作流](../../../../.github/workflows/desktop-release.yml)负责桌面 GitHub Releases。推送的标签必须与 Desktop 包版本精确一致，且位于 origin/main 历史中。源码与工具从该不可变标签检出；工作流不修改版本。原生 runner 使用冻结依赖安装，暂存固定版本 npm 运行时，并生成明确的产物清单。

[运行时与平台验证决策](2026-10-02-desktop-release-runtime-and-platform-validation.md)负责当前 Electron 固定版本与支持的发布平台。它部分取代本决策的双平台发布要求。Mac 产物仅使用 ad hoc 签名且未公证；Windows 发布暂停，待更新功能修复并验收。

构建任务只读仓库。只有 Release 任务获得 contents: write。它先创建 draft，按 SHA-256 核对精确的声明资产集合，跳过相同资产，并拒绝不同哈希、已发布资产缺失或未声明资产。它绝不覆盖资产。全部资产与来源验证通过后才发布；不生成 Desktop 更新器元数据。

Desktop App 版本与 vX.Y.Z 标签独立于 Harness npm 包族的 dsh-v* 标签和注册表版本。

## 曾考虑的替代方案

**在一个 runner 上构建两个平台。** Electron Builder 可以交叉打包部分目标，但已暂存运行时包含按平台选择的依赖。原生 runner 让安装、暂存和打包处在同一操作系统和架构上。

**只发布未封装的应用目录。** 目录适合本地验证，但不便作为 GitHub Release 下载。DMG、NSIS 和 ZIP 同时覆盖安装与便携检查，又无需提交生成输出。

**把签名状态视为平台验收。** 签名验证只能确认发布者身份，不能确认更新功能。当前发布决策要求将平台验收与签名状态分别判断。

## 后果

标签与资产哈希标识不可变的源码发布。只发布已声明且已验收的平台；任意必要构建或验证失败都会让 Release 保持未发布。各平台的打包与签名工具可以独立于公开发布资格保留。
