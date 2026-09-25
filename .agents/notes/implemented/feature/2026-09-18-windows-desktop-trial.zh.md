# Agent Note: Windows Desktop 本地试用

Status: implemented

[English](2026-09-18-windows-desktop-trial.md) | 中文

## 问题

macOS Desktop shell 的菜单角色、托盘图片与进程恢复命令无法直接提供可用的 Windows 试用版。仅有 Windows 打包目标不能证明运行时兼容。

## 决策

Windows 复用产品操作，使用平台对应的原生菜单角色、彩色托盘图标、原生标题栏按钮，并支持恢复最小化窗口。关闭窗口后 Desktop 保留在托盘中。macOS 保留既有菜单角色与模板图片。

本地 `dist:win` 命令生成未签名的 x64 NSIS 和 ZIP 产物，并禁用发布。NSIS 按当前用户安装，卸载时保留应用数据。运行时暂存提供固定版本的 npm；打包校验通过 Windows 应用可执行文件运行 npm。

托管子进程获得运行时所需的 Windows 环境变量。Windows 上父进程退出后 `ppid` 不会改变，因此父进程退出守护会探测父进程。恢复流程检查实时进程命令行是否引用托管目录，并等待进程退出，不会根据持久化 PID 终止进程。恢复失败会阻止所有修改程序文件的事务并清除启动描述，直到恢复成功。Harness 用户数据仍位于这些程序目录之外。

Windows 默认启动时，Desktop 偏好设置与托管 Harness 安装位于 `%USERPROFILE%\\.deepseek-desktop`，避开本机无法执行原子重命名的加密漫游配置目录。Electron 解析出的用户数据目录仍用于 Chromium Chat 配置、登录和 Memory。显式传入 `--user-data-dir` 时，程序文件仍保存在该配置目录内，各配置彼此隔离。升级后仅当新状态文件不存在时，才复制已验证的偏好设置；旧状态文件和浏览器配置都会保留。

## 曾考虑的替代方案

**复用 macOS 菜单与单色模板图片。** 这些菜单角色包含 Windows 不支持的操作，模板图片也不适合作为 Windows 托盘图标。

**根据记录的 PID 终止进程。** PID 被复用后不能证明归属。等待并拒绝恢复可以保留无关进程，代价是阻塞原因消失后需要重启应用。

**构建完成即发布。** 所有者要求先在本地使用数日，再决定是否发布。本地打包不授权创建标签或 Release。

## 后果

Windows 获得可安装的本地试用版，同时沿用 Chat、Memory 和 Harness 的边界。菜单、生命周期、真实子进程退出、恢复失败及 Windows npm 执行均有回归测试。真实 Chat 登录与持续 Windows 使用需要所有者验收；Windows 宿主无法验证 macOS GUI 行为。试用版保持未签名、未发布。

## 1.0.5 试用状态

1.0.5 Windows 工作将上游 Chat/Harness 通知设置与更新卡带入 Windows shell。Windows 与 macOS 一样启用系统通知，Harness 结果轮询也不再仅限 Darwin。定向测试覆盖通知选择、未读状态、菜单与生命周期以及更新阶段状态。已安装试用版中能看到通知设置，但没有登录 Chat 或触发真实 Harness 事件。

现有托管 Harness 仍在 DSH 子树使用 Cordis 4.0.2 / loader 1.0.3，而安装根目录使用 Cordis 4.0.4 / loader 1.0.5。默认 profile 实测复现 `entry._await is not a function`。仅含程序包的 synthetic profile 在统一为旧版本配对后通过启动并到达 HTTP token fence；试用机上的干净 npm 暂存安装没有完成。首次 GUI 验收启动 Desktop 时调用了 `prepareProfile()`，将默认 profile 的 `cordis.yml` 重写为空 YAML 列表；之后的离线工作没有修改已安装托管版本或 profile。构建来源、哈希与验收边界见对应日期的试用记录。
