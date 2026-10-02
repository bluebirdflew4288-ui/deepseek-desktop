# Agent Note: Desktop 发布验证运行时身份与平台就绪状态

Status: implemented

[English](2026-10-02-desktop-release-runtime-and-platform-validation.md) | 中文

## 问题

Desktop 发布包使用的 Electron 版本若与本机已验收运行时不同，就不能沿用该运行时的验收证据。原生打包成功也不能证明该平台的更新功能正常。

## 决策

Desktop 包与锁文件固定 Electron 44.0.0，与已验收的 Mac 运行时一致。发布构建将安装后的可执行文件和打包后的可执行文件置于 Electron Node 模式，比较 process.versions.electron 与包内固定版本。版本不一致或探测失败都会阻止上传。Harness 暂存使用发布包的依赖闭包，唯一例外是精确的旧版本 0.1.5-rc.2；该版本的 Cordis 覆盖不会限制后续官方更新。启动诊断只分类已识别的故障，不保留原始 Host 输出或凭据。

公开 Desktop 发布当前仅声明 mac-arm64。Windows 更新功能待修复并验收，因此保留 Windows 打包工具，但发布工作流不构建或发布 Windows 资产。发布同步器要求显式声明平台，验证每个声明资产，并在发布前拒绝未声明资产。Release Notes 从同一个源码包读取 Electron 版本，并说明 Windows 暂停发布。

本决策部分取代[标签驱动发布决策](2026-08-17-tag-driven-desktop-github-releases.md)中的平台要求；不可变标签、版本匹配、来源提交与验证前保持草稿的规则继续适用。正常标签构建使用该标签的源码和工具；当前工作流没有 main 源码覆盖，也没有旧版本恢复 dispatch。

## 曾考虑的替代方案

**只要 CI 打包成功就发布两个平台。** 不采纳，因为打包不能证明更新功能正常或用户已验收。

**替换既有标签下的资产。** 不采纳，因为下载与哈希将不再指向一个不可变发布；运行时修正使用新的 App 版本与标签。

**只修改 Electron 依赖字符串。** 不采纳，因为打包可能使用已物化的 Electron 分发文件；可执行文件探测才能验证实际发出的运行时。

## 后果

Mac 发布保持 ad hoc 签名且未公证。Desktop App 升级需要下载新发布包；Harness 更新继续下载官方 npm 包。Windows 更新功能修复并验收后，必须显式修改工作流与平台声明才能恢复发布。不引入 Node 环境管理器、自动源码合并或开发环境重设计。

## 验证

运行时测试拒绝旧运行时和不完整探测。清单同步覆盖 Mac-only 与显式双平台集合，并拒绝未声明的 Windows 资产。原生发布任务验证封装后的运行时、npm launcher、DMG 身份与签名。一次性官方 Harness 安装和健康检查验证兼容性，不修改已安装的用户配置。
