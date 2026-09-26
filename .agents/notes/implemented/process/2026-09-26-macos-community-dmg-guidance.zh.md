# Agent Note: macOS 社区版安装指南随 DMG 分发

Status: implemented

[English](2026-09-26-macos-community-dmg-guidance.md) | 中文

## 问题

GitHub 社区版仅使用 ad-hoc 签名且未经公证，因此 macOS 首次启动时可能要求用户再次确认。此前 DMG 只有应用和 Applications 链接，用户下载后没有安装或 Gatekeeper 提示说明。Release Notes 还将应用源码归属到 workflow 上下文 SHA；恢复发布时，该值可能指向发布工具。

## 决策

DMG 使用 electron-builder 的 `dmg.contents`，在根目录放置应用、指向 `/Applications` 的链接和 UTF-8 `安装指南.txt`。指南位于 `apps/desktop/release-resources`，不会进入应用资源或 `app.asar`；ZIP 结构保持不变。指南说明 ad-hoc 签名、没有 Developer ID 和公证，以及 macOS 的 Finder 确认方式，不建议用户关闭 Gatekeeper。

Release Notes 分别标注从不可变 release tag 解析的应用源码提交和发布工具提交。工作流在上传前验证 DMG 根目录内容和应用身份。

已发布的 v1.0.5 Release Notes 保留原有来源字段。恢复流程只能验证这一条确切的旧记录，不会更改它的说明或资产；后续版本必须提供两个来源字段。

## 考虑过的替代方案

**把指南放入应用资源或 `app.asar`。** 指南只服务于安装流程；将其打入已安装应用会重复携带发布材料，也会不必要地改变已签名应用。

**在 ZIP 中添加指南。** DMG 是带有引导说明的主要安装路径。修改 ZIP 流程会增加打包工作，却不改善所要求的 DMG 流程，因此 ZIP 仍只包含便携应用。

**建议移除 quarantine 属性或关闭 Gatekeeper。** 这些步骤会削弱系统保护，也不是默认首次启动流程的必要条件；指南改为引导用户使用 Finder 和 macOS 设置界面。

## 影响

DMG 增加一个可见文本文件，并验证应用到 Applications 的布局。已安装应用和 ZIP 不包含这份指南。社区版仍是 ad-hoc 签名且未经公证；用户首次启动时仍可能需要通过 macOS 界面确认。

## 测试

打包测试检查指南路径和配置。macOS 发布门禁会挂载 DMG、验证文件系统、检查根目录项目、确认指南为 UTF-8、验证应用 bundle identity 和 arm64 架构，并验证代码签名。
