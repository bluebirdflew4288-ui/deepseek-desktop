# Security / 安全

This community project has no dedicated security response team or guaranteed response time. This development build is not a signed stable release. 本社区项目没有专职安全响应团队或保证的响应时限，当前开发构建不是已签名的稳定版本。

## Reporting / 报告

Do not post exploitable details, credentials, cookies, Memory exports, or session logs in public issues. Use GitHub's private vulnerability reporting option for this repository if available. If it is unavailable, open an issue containing only a request for a private reporting channel, with no exploit or personal data; wait for the maintainer to provide one. Do not send this derivative's private reports to unrelated upstream maintainers. 请勿在公开 Issue 中发布可利用细节、凭据、Cookie、Memory 导出或会话日志。若本仓库提供 GitHub 私密漏洞报告入口，请使用该入口；否则仅提交请求私密沟通渠道的 Issue，不含漏洞细节或个人数据，等待维护者提供渠道。不要将本衍生项目的私密报告发给无关上游维护者。

Once a private channel is established, provide the affected commit/version, operating system, a minimal reproduction using synthetic data, expected impact, and any workaround. Redact API keys, proxy credentials, tokens, browser profiles, and personal paths. 私密渠道建立后，提供受影响版本、操作系统、使用合成数据的最小复现、影响和临时措施，并去除密钥、代理凭据、Token、浏览器 profile 和个人路径。

## Data and execution / 数据与执行

Chat and selected Memory in prompts are sent to the official DeepSeek service. Memory JSON exports are not encrypted by Desktop. Clearing Chat data also deletes local Memory. Harness credentials are independent of Chat login. Chat 与提示词中的选中 Memory 会发送给 DeepSeek 官方服务；Desktop 不对导出的 Memory JSON 加密；清除 Chat 数据也会删除本地 Memory；Harness 凭据与 Chat 登录独立。

Managed Harness isolates program versions and verifies process ownership; it is not a complete OS-level sandbox. Harness tools can use local files, processes, and network access according to their configured permissions. Update/rollback changes program versions and does not restore user data. 托管 Harness 隔离程序版本并检查进程归属，但不是完整的操作系统级沙箱；工具依照配置的权限访问文件、进程与网络。更新/回滚切换程序版本，不恢复用户数据。

## Maintainer handling / 维护者处理

Confirm the affected revision, reproduce with disposable data, and coordinate disclosure after a fix or documented mitigation. A discovered real credential requires revocation and a separate history-remediation decision; deleting it in a new commit does not remove it from Git history. 核实受影响 revision，使用可丢弃数据复现，并在修复或记录缓解措施后协调披露。发现真实凭据时须撤销凭据并单独决定历史修复方式；新提交删除凭据不会消除 Git 历史中的内容。
