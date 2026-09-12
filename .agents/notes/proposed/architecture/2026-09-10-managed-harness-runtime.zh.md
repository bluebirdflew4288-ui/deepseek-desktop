# Agent Note: Managed Harness Runtime 拥有官方 Harness 版本

Status: proposed

[English](2026-09-10-managed-harness-runtime.md) | 中文

## 问题

打包后的桌面应用只携带一个固定的 Harness 版本。`apps/desktop/scripts/stage-runtime.ts` 把完整的 `@deepseek-ai/dsh` 依赖闭包物化到 `apps/desktop/runtime-host`，Electron Builder 再把它复制到 `resources/host`，supervisor 启动 `resources/host/node_modules/@deepseek-ai/dsh/lib/bin.js`。因此官方 Harness 每次发版都要重新构建并重新发布整个桌面应用，桌面壳版本与 Harness 版本无法独立演进。

已发布的 Harness 也已经超出被打包闭包的行为。本 checkout 打包的是 `0.1.0-rc.5`，而官方 registry 的 `latest` 标签指向 `0.1.5-rc.1`。两者在 supervisor 依赖的契约上并不一致：`0.1.5-rc.1` 输出 `dsh web: http://127.0.0.1:<port>/?token=<launch-token>`，而 `0.1.0-rc.5` 输出裸 origin；它用 launch token 换取绑定 authority 的签名 cookie 来认证浏览器，而不是本 checkout 在 `packages/client/connection/src/api-token.ts` 中添加的 `apiToken` bearer；它还注册了 `--no-open`，因为 `openBrowser` 默认会把 Web UI 交给用户的默认浏览器。要安装官方包的 supervisor 必须使用官方契约，而不是被打包版本的契约。

## 提案

`apps/desktop/src/managed-harness*.ts` 是桌面受管的 Harness 程序目录。它从官方 npm registry 把官方 `@deepseek-ai/dsh` 安装到桌面自己拥有的目录，只保留两个程序版本，并切换 Harness 标签页启动哪一个。Harness *用户*数据不属于它：CLI 自己解析 home（`~/.dsh`，可用 `$DSH_HOME` 覆盖），settings、credentials、sessions、profiles、storages 和 attachments 都在那里，所以本模块的任何事务都不读取、移动、复制或删除它，版本切换也不需要迁移。

执行环境是 Electron 二进制自带的 Node，以 `ELECTRON_RUN_AS_NODE=1` 和 `--expose-internals` 启动。Electron 43.4.0 携带 Node 24.18.1，满足 `@earendil-works/pi-ai` 传递声明的有效引擎下限 `>=22.19.0`，而 `--expose-internals` 正是 vendored Cordis loader 访问 `internal/modules/esm/loader` 所需要的。再附带一个 Node 可执行文件会增加约 180 MB 和一个签名面，却不改变上述任何一点。

安装器在同一个 Electron Node 下运行桌面自带的 npm CLI，固定 `--registry https://registry.npmjs.org/`，并把两个配置槽都指向桌面自己拥有的空文件，因此个人 registry 镜像或放宽的 integrity 设置都无法影响受管安装。它按 npm 默认规则解析 peer，并跳过 install script。两个选择都是关键：`--legacy-peer-deps` 会漏掉 Harness 闭包以 peer 声明的 24 个 Service Definition 包，缺少它们 CLI 无法启动；而闭包中每个原生模块（`node-pty`、`sharp`）都自带预编译二进制，因此不需要运行任何脚本。环境是显式构造而非继承的，其 `PATH` 只包含操作系统目录，所以受管安装无法解析到用户自己安装的 Node、npm 或 npx。

只读取官方 `latest` 发布标签。不查询预发布通道，因此 alpha 或 nightly 构建永远不会被作为更新提供；也没有任何定时查询：读取 registry 是用户主动行为。

一次事务先 stage 到 `staging/<version>`，校验安装后的 manifest 确实是所请求的包和版本，再用生产参数针对 `staging/` 下的一个 Harness home 启动候选版本做 health check，然后把目录 rename 到 `versions/<version>`，最后才写入命名它的 state。目录先落地、state 后指向它，所以两者之间崩溃会保留上一个已提升版本，而候选版本处于未被引用状态，由清理逻辑删除。提升会把即将退位的 current 变成回滚目标，并清理更早的版本，因此程序树只保留两个版本、不会堆积。回滚先对目标做 health check，检查失败时保持 current 不变。回滚只移动程序文件；没有用户数据快照，也没有需要恢复的内容。

版本 state 是一份原子文档，记录 `current`、`previous` 和进行中的 `pending` 事务。无法识别的文档被报告为不可用而不是猜测，启动时存在 `pending` 标记意味着该事务从未完成，因此恢复流程丢弃该候选并保留最后一个已验证版本。

进程所有权不能只依赖进程标识符。supervisor 持有它自己 spawn 的子进程句柄，所以常规停止是直接的。对于先前崩溃的启动可能仍然拥有的 Harness，恢复流程读取所记录标识符对应进程的真实命令行，只有当推导出的受管 CLI 命令与实时进程环境中的单次启动身份同时匹配时才发信号。用户自己启动的 Harness、另一个桌面实例的 Harness，以及任何复用该标识符的无关进程都不满足这个检查，会被保留运行。Harness 绑定 loopback 上由操作系统分配的端口，因此永远不会与其他进程持有的端口争用，也不会按端口或按名称杀进程。

readiness parser 接受官方的 `?token=` query 并把 launch token 暴露出来，Harness surface 把它带入首次文档加载，让 Host 用它换取 cookie。`searchParams.set` 保证 token 只出现一次，因为 Host 会拒绝携带两个 token 的 handoff URL。token 是进程级的：从不持久化、从不写日志、从不跨启动复用，而诊断日志只记录操作事实，因此凭据不可能进入日志。不产生 token 的 Host 仍然通过 spawn 环境中的 bearer 认证，surface 只在没有 token 时才附加该 bearer，两种模型不会重叠。supervisor 的关闭宽限是 8s，严格高于 CLI 自己的 5s force-exit 定时器，因此升级信号不会与仍在完成自身 teardown 的子进程竞争。

候选包携带壳资源与固定的 npm 11.12.1，不携带 `resources/host` 闭包。没有已提升的托管版本时显示安装界面。npm 固定清单记录官方 registry 来源、tarball 完整性和许可证；打包检查会验证其内容与可执行入口。

提升版本前，解析出的发布完整性值必须与安装后的 lock 条目一致。替换过程将保留版本目录放入 `replacement-backup`，直到原子版本状态提交，因此两次重命名之间或之后的中断都能还原原目录。单次启动的随机身份与推导出的 CLI 命令共同防止 PID 复用或记录替换授权错误信号。父进程退出监视器使安装器和 Harness 子进程随 Desktop 终止；恢复还会在回收 staging 前探测实时安装进程身份，并拒绝截断或失败的探测。

## 曾考虑的替代方案

**附带独立的 Node.js 运行时。** 约 180 MB、多一个需要签名的 Mach-O，并且不提供 Electron 二进制在引擎下限之上已有的能力。

**继续打包固定 Harness 版本并整体更新应用。** 这正是本决策要解除的耦合。

**自行实现 registry 安装器。** 解析 521 个包意味着自己拥有 semver range、peer 与 optional dependency、平台过滤和 integrity 校验。闭包的 peer 声明恰恰是朴素解析器会算错的部分，而算错产生的树是在启动时失败，不是在安装时失败。

**用 `--legacy-peer-deps` 加快安装。** 已验证会漏掉 24 个 peer 包；CLI 随后以 `ERR_MODULE_NOT_FOUND` 失败，缺少 `@deepseek-ai/cordis-plugin-group`。

**fork 官方 Web UI 以保留本 checkout 的桌面嵌入适配。** 已发布的 `@deepseek-ai/dsh-web-frontend` 不含 `data-dsh-desktop-embedded` 样式，也没有桌面主题桥，因此官方 Web UI 在 Harness 标签页中以浏览器形态渲染。重新加回这些意味着针对每个官方版本维护一份前端 fork，而这正是本决策要解除的耦合。桌面仍然发送 `dsh-desktop-platform` 和 `dsh-desktop-embedded`，因此官方前端一旦支持即可直接生效。

**为了隔离而把 `$DSH_HOME` 指向桌面管理的目录。** 那样能把 Harness 与用户自己安装的第三方 profile 插件隔离开，但会让用户已有的 settings、credentials 和 sessions 变成孤儿。隔离属于测试职责，测试按运行设置 `$DSH_HOME`；产品使用 CLI 自己解析的 home。

## 已完成的验证

`apps/desktop/tests/managed-harness.spec.ts` 的单元与集成覆盖包含：首次安装、已安装时的 up-to-date 短路、只读 registry 的更新检查（无启动查询、无定时查询）、提升、只保留两个版本、清理未引用版本与 staging、安装失败、版本被替换、health check 失败、registry 不可达、回滚、回滚目标不健康、没有回滚目标、重新安装、从 pending 标记的崩溃恢复、不可用的 state 文档、安装器参数与环境、health check 对 `$DSH_HOME` 的隔离、日志轮转，以及三种所有权场景。`host-supervisor.spec.ts` 固定 token readiness 契约与 `--no-open` 的按需开启；`harness-surface.spec.ts` 固定携带 token 的 Host 只加载一次 token 且不附加 bearer。

在确定设计之前，已针对真实发布包做过实证验证：使用默认 peer 解析与 `--ignore-scripts` 的 `npm install @deepseek-ai/dsh@latest` 产出完整的 521 包依赖树；该树在 `ELECTRON_RUN_AS_NODE=1` 加 `--expose-internals` 下可以启动，只绑定 `127.0.0.1` 上分配的端口，约 10s 达到 readiness；不带 token 的 `GET /` 返回 401，带 token 返回 303 并设置 `HttpOnly; SameSite=Strict` cookie，该 cookie 可以取到真实的 27 KB Web UI；桌面自己的 query 参数能与 token 共存，而重复的 token 被拒绝；`SIGTERM` 在数秒内释放端口；全过程用户真实的 `~/.dsh` 未被改动。

## 验收标准

当一个已打包的 macOS arm64 构建携带 stage 好的 npm CLI、且不再包含 `resources/host` 闭包，并在真实应用（而非 fixture）中证明以下全部条目时，本 Agent Note 才移入 `implemented/`：

- 首次运行显示 Harness 标签页的 setup 状态，用户一次操作即可安装官方 `latest` 并提供其 Web UI，全过程 Chat 独立正常工作。
- 完整重启应用后，已有受管版本能针对用户真实 Harness home 启动，既有 settings、credentials 和 sessions 完好。
- 手动检查更新能报告官方 `latest` 版本，且启动时与任何定时任务都不查询 registry。
- 更新成功时提升新版本、把退位版本保留为回滚目标并清理更早版本；更新失败、版本被替换、health check 失败三种情况都保持退位版本可启动。
- 回滚能恢复保留版本并交换保留关系；回滚目标 health check 失败时保持 current 不变。
- 事务被中断后，下次启动恢复到最后一个已验证版本，没有半切换状态，也没有 staging 残留。
- Harness 只绑定 loopback，用户自己启动的 Harness 永远不会被发信号，端口被占用时不杀任何进程。
- `Command+W` 仍然只隐藏不退出，`Command+Q` 仍然停止自己拥有的 Harness 子进程，不留 owned orphan。
- Chat 与 Local Memory 未变，Harness session 不加载 Memory extension，重新打包后 Memory source/package 资源树仍为 `MATCH`。
- stage 进资源的 npm CLI 的版本与 license 已在重新生成的 `THIRD_PARTY_NOTICES.md` 中披露，且仓库、诊断日志与版本 state 中都不出现 launch token、bearer、cookie 或任何凭据。

## 风险

**官方契约可能再次变化。** 本 checkout 是 `0.1.0-rc.5`，registry 的 `latest` 是 `0.1.5-rc.1`，两者在 readiness URL、认证模型和浏览器 handoff 上已经不一致。后续版本可能再次改变 readiness 行、token 交换或 `--no-open`。health check 是遏制手段：无法启动并提供服务的版本永远不会被提升，因此契约破裂的代价是一次失败的更新，而不是一个坏掉的 Harness。

**受限网络下冷安装很慢。** 仅解析就要拉取 521 个包，而在一个会重置连接的透明代理后面，单个 packument 曾耗时 201s。上限是 15 分钟并给出明确失败，但在这类网络上首次安装可能让用户以为卡死。

**官方 Web UI 没有桌面集成。** 已发布的前端不含桌面嵌入样式与主题桥，因此 Harness 标签页以浏览器形态渲染，桌面显式的主题偏好也传不进去。相对被打包闭包这是一处可见的产品变化，本决策接受它而不是解决它。

**共享 Harness home 意味着共享配置。** `~/.dsh/cordis.patch.yml` 与 `~/.dsh/profiles/web/cordis.patch.yml` 属于用户，优先级高于 profile 层，且 web profile 会热重载它们。两者都能在受管启动下重新绑定 webserver host 或抑制 readiness 行。parser 会拒绝非 loopback 的 readiness URL，因此重新绑定的结果是启动明确失败，而不是把 Harness 暴露出去。

**两个程序版本约占 578 MB。** 保留数量有上限且清理已验证，但下限就是两份完整依赖闭包，小容量磁盘的用户会明显感知。
