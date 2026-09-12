# 贡献

[English](CONTRIBUTING.md) | 中文

本仓库的贡献面向社区 Desktop 衍生项目。上游 DeepSeek Harness 及其他项目有各自的贡献政策，本仓库不代表它们发言。当前产品开发阶段已封箱，大规模工作前请先与维护者讨论聚焦的修复或后续范围。

## 提出修改

在本仓库的 Issue 或 Pull Request 中描述问题、受影响的平台/版本，以及使用合成数据的最小复现。安全报告请遵循 [SECURITY.md](SECURITY.md)。不要附带真实 Chat 历史、Memory、API 密钥、Cookie 或本地运行时 profile。

保持修改聚焦，保留上游许可证、署名和修改文件说明。中英文文档同步更新。仓库规范见 [AGENTS.md](AGENTS.md)、[桌面指南](apps/desktop/README.md) 和[开发指南](docs/development.md)。

## 开发与验证

使用 Node.js `^22.19.0` 或 `>=24.0.0`，以及 pnpm `11.7.0`：

```sh
pnpm install
pnpm run dev:desktop
```

选择覆盖修改的最小测试集，并报告实际执行的命令。Desktop 源码测试、类型检查、打包行为和文档检查分别证明不同事项。运行时验证使用隔离且可丢弃的 Desktop 与 Harness profile，禁止使用真实用户 Memory 做实验。

不要提交 `node_modules`、指向其他 checkout 的符号链接、`lib`、`dist`、`output`、scratch 文件、缓存、用户 profile、日志或凭据。不要修复其他 checkout 的依赖链接。已有 lint/文档技术债必须与新增失败分开说明。

## 发布

贡献不构成对 Release、签名、公证或仓库可见性修改的授权；这些操作需要维护者单独决定。保留已有许可证条款；在此贡献不意味着上游作者认可本衍生项目。
