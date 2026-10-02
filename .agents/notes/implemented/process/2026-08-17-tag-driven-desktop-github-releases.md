# Agent Note: Tag-driven desktop GitHub releases

Status: implemented

English | [中文](2026-08-17-tag-driven-desktop-github-releases.zh.md)

## Problem

The desktop application had local packaging commands but no repository workflow that produced downloadable macOS and Windows applications. The existing release workflows publish npm, Python, vendored, and native package families; extending one of them would couple desktop artifacts to a different version line and publication destination.

A desktop release also needs platform-native runtime staging. Building both platforms on one host can package the Electron shell, but it does not prove that the staged Host dependency tree matches the target operating system and architecture.

## Decision

The [Desktop Release workflow](../../../../.github/workflows/desktop-release.yml) owns desktop GitHub Releases. A pushed tag must exactly match the Desktop package version and point into origin/main history. Source and tooling are checked out from that immutable tag; the workflow does not change package versions. Native runners install frozen dependencies, stage the pinned npm runtime and produce explicit artifact manifests.

The [runtime and platform validation decision](2026-10-02-desktop-release-runtime-and-platform-validation.md) owns the current Electron pin and supported release platforms. It partially supersedes this note's two-platform publication requirement. Mac artifacts use ad hoc signatures and are not notarized; Windows publication is paused pending update-function repair and acceptance.

Build jobs have read-only repository permissions. Only the Release job receives contents: write. It creates a draft, reconciles the exact declared asset set by SHA-256, skips identical assets and refuses different hashes, missing published assets or undeclared assets. It never overwrites assets. Publication follows full asset and provenance verification; Desktop updater metadata is not generated.

Desktop App versions and vX.Y.Z tags remain independent of the Harness npm family's dsh-v* tags and registry versions.

## Alternatives considered

**Build both platforms on one runner.** Electron Builder can cross-package some targets, but the staged runtime contains platform-selected dependencies. Native runners keep installation, staging, and packaging on the same operating system and architecture.

**Publish only unpacked application directories.** Directories are useful for local verification but inconvenient GitHub Release downloads. DMG, NSIS, and ZIP cover installation and portable inspection without committing generated output.

**Treat signature status as platform acceptance.** Signing checks establish publisher identity, not update functionality. The current release decision requires platform acceptance separately from signature status.

## Consequences

Tags and asset hashes identify immutable source releases. Only declared, accepted platforms are published; any required build or verification failure keeps the Release unpublished. Platform-specific packaging and signing can remain available independently of public release eligibility.
