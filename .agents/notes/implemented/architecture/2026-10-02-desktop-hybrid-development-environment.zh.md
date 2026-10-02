# Agent Note: Desktop owns Harness runtime and supplements local development paths

Status: implemented

中文 | [English](2026-10-02-desktop-hybrid-development-environment.md)

## Problem

GUI 启动会遗漏用户登录 shell 导出的开发路径。即使 Host 可执行文件固定，完整继承 Desktop 环境仍会让 Node 启动钩子改变托管 Host。Agent 需要基本 Node 命令能力，而不要求用户另装系统 Node。

## Decision

Desktop 构造日常 Host 环境，不修改 Electron process.env。有总时限且可取消的 POSIX 登录 shell 探测只导出 PATH 和七个 SDK 路径变量；Windows 使用继承环境。用户开发路径保持顺序，再补缺失的继承路径与系统目录，最后加入打包版 Desktop 兜底命令；拒绝相对路径和空路径。各命令独立解析，执行失败或版本不匹配后不会改用兜底重试。清理启动钩子与内部命名空间后，Desktop 恢复选定的 DSH_HOME、启动身份和 Electron Node 模式，再加入父进程 watchdog。Electron Node 调用预加载 Desktop bootstrap，在应用代码执行前移除 ELECTRON_RUN_AS_NODE；普通任务、npm lifecycle scripts 与 npx 命令不会继承模式变量。公共 child_process API 仅在无 shell、直接复用 process.execPath 时保留 Node 模式和同一 preload，包括 Harness 内部 runner 与 fork；外部可执行文件保持自身启动模式。bootstrap 不修改已安装 Harness 或 bundled npm。保留 NODE_EXTRA_CA_CERTS、NODE_USE_SYSTEM_CA、NODE_USE_ENV_PROXY 和普通代理、locale 设置，不保留 NODE_TLS_REJECT_UNAUTHORIZED。

可搬迁的 node/npm/npx shell launcher 复用 Electron executable 与已有 bundled npm CLI 依赖闭包，保留参数、cwd 和退出状态，并设置 Electron Node 模式。兜底 npm/npx 在 Electron 下运行，lifecycle scripts 则按任务 PATH 查找 node。项目 npm 使用普通 npmrc、registry 与 cache 行为；全局安装默认位于 POSIX 的 HOME/.local，或 Windows 的 APPDATA/npm（没有 APPDATA 时使用 USERPROFILE/.local）。已有 PREFIX 与显式 npm 配置覆盖该默认值。默认全局命令目录补在用户/系统路径之后、兜底 launcher 之前；自定义 prefix 需要自己的 PATH 设置。Windows 提供 cmd/PowerShell launcher；无 shell CreateProcess 调用方需要真实 executable 或 process.execPath。Desktop 不打包 Git、语言 SDK 或系统包管理器。

维护事务继续由[托管 Harness 设计](../../proposed/architecture/2026-09-10-managed-harness-runtime.md)约束：隔离的进程环境、bundled npm、受控 registry/config/cache 与一次性健康检查 home。该记录的版本事务和所有权规则仍独立适用；本决策补充日常任务环境发现与命令，不取代维护机制。Chat 不接收发现环境或 launcher。源码开发保留 DSH_DESKTOP_NODE_EXECUTABLE 或 PATH node，不加入打包版兜底目录，也不需要 staged npm。

探测参考[官方 Desktop](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/apps/desktop/src/login-shell-environment.ts)的定界、账户 shell 与回退机制，增加总预算、输出上限、筛选与进程组清理，不复制上游完整环境覆盖策略。

## Alternatives considered

**仅继承 GUI 环境。** 启动成本低，但会遗漏常见 Homebrew 与版本管理器安装。

**完整登录 shell 环境覆盖。** 接近 Terminal 配置，却允许 Node 钩子、内部变量覆盖与无关 shell 导出进入 Host 启动。

**Desktop 开发命令优先或 Node 工具链管理器。** 前者覆盖用户选择，后者增加版本选择职责；按命令独立的 PATH 兜底保留已有命令并暴露其失败。

**单独 Node 或内置开发工具链。** 扩大分发、签名与更新职责；Electron 和已有 npm 已能提供所需基础 Node 能力。

## Consequences

本机 node/npm/npx 优先，允许本机 Node 配合兜底 npm 等混合来源；Desktop 不静默修复版本不兼容或损坏的本机命令。Host 启动不会继承 NODE_OPTIONS 或 NODE_PATH。本机开发工具可以使用任务显式提供的 runtime 钩子；Desktop 兜底 node/npm/npx 会清除 NODE_OPTIONS 和 NODE_PATH，避免外部 startup hooks 干扰 Electron Node 启动。发现时会执行登录 shell rc 代码，代码可能有自己的副作用；Desktop 不修改这些文件。发现失败回退至继承路径，不阻断维护或 Chat。环境只在每次 Desktop 启动时发现一次：已有 PATH 目录中新加的工具立即可见；新增目录需要重启 Desktop 或显式设置任务环境，单独重启 Harness 不会重新发现环境。Windows 原生命令互操作与 Linux 打包需要本机平台验收；高级 MSVC 环境激活不属于本决策。

## Verification

解析与进程测试覆盖定界输出、失败回退、超时、取消与进程组清理。环境测试约束变量所有权、SDK 筛选、PATH 顺序和别名及维护隔离。真实命令测试验证本机优先、失败可见、Node 兜底、混合 lifecycle scripts、用户目录全局安装、npm 配置与搬迁。可运行的无密钥 Host fixture 组装真实 Harness shell/subprocess provider 并快照任务输出。打包验证所有 launcher 调用包内 Electron executable，以及固定 npm/npx 版本。
