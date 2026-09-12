# Contributing

English | [中文](CONTRIBUTING.zh.md)

Contributions here concern this community Desktop derivative. Upstream DeepSeek Harness and other projects have their own contribution policies; this repository does not speak for them. The current product development stage is sealed. Discuss focused fixes or a future scope with the maintainer before substantial work.

## Proposing changes

Describe the problem, affected platform/version, and a minimal reproduction with synthetic data in this repository's issue or pull request. Use [SECURITY.md](SECURITY.md) for security reports. Do not attach real Chat history, Memory, API keys, cookies, or local runtime profiles.

Keep changes focused and preserve upstream licenses, attribution, and modified-file notices. Update English and Chinese documentation together. Read [AGENTS.md](AGENTS.md), [the desktop guide](apps/desktop/README.md), and [the development guide](docs/development.md) for repository conventions.

## Development and validation

Use Node.js `^22.19.0` or `>=24.0.0` and pnpm `11.7.0`:

```sh
pnpm install
pnpm run dev:desktop
```

Select the smallest tests that cover the change and report commands actually run. Desktop source tests, type checks, packaged behavior, and documentation checks prove different things. Use isolated disposable Desktop and Harness profiles for runtime validation; never use real user Memory for experiments.

Do not commit `node_modules`, symlinks into another checkout, `lib`, `dist`, `output`, scratch files, caches, user profiles, logs, or credentials. Do not repair another checkout's dependency links. Known inherited lint/documentation debt must be disclosed separately from new failures.

## Publication

A contribution does not authorize a release, signing, notarization, or changes to repository visibility. Those require a separate maintainer decision. Preserve the existing license terms; contributing here does not imply that any upstream author endorses this derivative.
