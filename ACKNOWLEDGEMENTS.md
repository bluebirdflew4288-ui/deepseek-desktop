# Acknowledgements / 上游致谢

This community derivative is not affiliated with or endorsed by the projects below. Attribution identifies the sources used, not collaboration or official authorization. 本社区衍生项目与下列项目无已证实的合作或背书关系；署名用于说明实际来源，不代表官方授权。

## Desktop foundation / Desktop 基础

Thanks to [@zcx960 / deepseek-desktop](https://github.com/zcx960/deepseek-desktop/tree/1e189113f7edce2da71e96c3378cbc454bc32214) for the Desktop foundation, including existing localization and shell integration. This derivative adds local Chat Memory and Managed Harness runtime work. 感谢 @zcx960 提供 Desktop 基础及已有中文化、桌面整合实现；本衍生项目增加本地 Chat Memory 与 Managed Harness 运行时工作。

The shared upstream ancestor is `1e189113f7edce2da71e96c3378cbc454bc32214`. Its [MIT license](https://github.com/zcx960/deepseek-desktop/blob/1e189113f7edce2da71e96c3378cbc454bc32214/LICENSE) contains `Copyright (c) 2026 DeepSeek`; the complete notice is retained in [LICENSE](LICENSE). No separate upstream root NOTICE was present at that revision. 共同上游 revision 如上，其 MIT 版权声明与许可证全文保留在根 LICENSE；该 revision 无独立根 NOTICE。

## DeepSeek Harness

Thanks to [DeepSeek AI / DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) for the plugin framework, CLI, and WebUI. The source tree includes Harness code inherited through the Desktop ancestor. The packaged app independently installs official `@deepseek-ai/dsh`; accepted runtime version `0.1.5-rc.1` declares MIT and includes `Copyright (c) 2026 DeepSeek` in its LICENSE. The root MIT notice remains intact. 感谢 DeepSeek AI 提供 Harness 插件框架、CLI 与 WebUI；源码通过 Desktop 上游继承，打包应用另行安装官方 npm 包。已验收运行时版本为 `0.1.5-rc.1`，其 MIT LICENSE 包含上述 DeepSeek 版权声明。

## DeepSeek++ Memory

Thanks to [DeepSeek++ / deepseek-pp](https://github.com/zhu1090093659/deepseek-pp/tree/0a02c72b135bf2936e11aa78fd6136931ed65908) and its contributors for the Memory implementation. The used source revision is `0a02c72b135bf2936e11aa78fd6136931ed65908` (1.14.0), which declares Apache-2.0 but, as reviewed, does not identify a copyright holder, ships no separate NOTICE, and carries no per-file license headers. The derivative therefore ships the complete upstream [Apache-2.0 license](apps/desktop/resources/deepseek-memory/LICENSE) unchanged and records its changes in a [modification notice](apps/desktop/resources/deepseek-memory/NOTICE.md); two of its own source files add a header naming the upstream files they derive from, and the remaining files in this derivative were implemented for the Electron-specific integration and do not carry upstream per-file headers. No upstream NOTICE was found at that revision, so none is retained. 感谢 DeepSeek++ 作者与贡献者；Memory 专用衍生实现所用上游 revision `0a02c72b135bf2936e11aa78fd6136931ed65908`（1.14.0）声明 Apache-2.0，但经核验，在所核验的上游 revision 中未发现明确的版权持有人声明、无独立 NOTICE，也没有逐文件许可证头。因此本衍生实现原样保留完整的上游 Apache-2.0 许可证，并在修改说明中记录改动；其自身有两个源文件额外标注了所对应的上游来源文件，其余文件是为 Electron 专用集成而实现，且不带有上游逐文件文件头。该 revision 未发现上游 NOTICE，故无需保留。Memory 的许可证不被根 MIT 文件取代。

## Other components / 其他组件

| Component / 组件 | Terms and retained material / 条款与保留材料 |
| --- | --- |
| Cordis and foundation libraries / 基础库 | MIT; `Copyright (c) 2021-present Shigma`, retained in each `vendor/*/LICENSE`. Revisions and modifications: [vendor/README.md](vendor/README.md). / 各目录保留许可证，revision 与修改记录见链接。 |
| Native Landlock launcher / 原生启动器 | BSD-3-Clause, `Copyright (c) 2026, node-addon-landlock-run contributors`; [license](native/landlock-run/LICENSE). / 保留 BSD 三条款及版权声明。 |
| npm 11.12.1 | Artistic-2.0 for npm itself, `Copyright (c) npm, Inc. and Contributors`; bundled dependencies retain their own terms. [Pin](apps/desktop/npm-runtime.json), [source](https://github.com/npm/cli/tree/v11.12.1); the complete unmodified LICENSE and dependency notices travel with the packaged npm tree. / npm 本体采用 Artistic-2.0，依赖遵循各自条款，完整许可证随打包树保留。 |
| Electron, Chromium, Node.js | Electron's installed distribution provides `LICENSE` and `LICENSES.chromium.html`. The sealed local app omits those files; preserving them is a prerequisite for a future binary release, which this source publication does not include. / Electron 安装分发含上述声明，但本地封箱 app 未包含；后续二进制发布前必须补齐，本次源码公开不分发该 app。 |
| Other dependencies / 其他依赖 | [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), [lockfile](pnpm-lock.yaml), and each component's license govern their respective code. / 各组件的代码遵循自己的许可证。 |

Existing upstream notices must accompany redistribution. The root MIT license is not a blanket license for all dependencies, bundled binaries, websites, or trademarks. 必须随再分发保留上游声明；根 MIT 许可证不是对所有依赖、二进制、网站或商标的统一授权。
