# Agent Note: Tag-driven desktop GitHub releases

Status: implemented

English | [中文](2026-08-17-tag-driven-desktop-github-releases.zh.md)

## Problem

The desktop application had local packaging commands but no repository workflow that produced downloadable macOS and Windows applications. The existing release workflows publish npm, Python, vendored, and native package families; extending one of them would couple desktop artifacts to a different version line and publication destination.

A desktop release also needs platform-native runtime staging. Building both platforms on one host can package the Electron shell, but it does not prove that the staged Host dependency tree matches the target operating system and architecture.

## Decision

`.github/workflows/desktop-release.yml` owns desktop GitHub Releases. A pushed `vX.Y.Z` tag must exactly match `apps/desktop/package.json` and point into `origin/main` history before either native build starts. Each job performs an immutable install, confirms runner architecture, builds the repository, stages the pinned npm runtime, and prepares a manifest containing only its declared distributables. Desktop remains at version `1.0.5`; the workflow never changes package versions.

The macOS Apple Silicon job produces DMG and ZIP files with an ad hoc signature only; these artifacts have no Developer ID distribution signature and are not notarized. The Windows x64 job requires a PFX, its password, the expected full certificate Subject, and an RFC 3161 timestamp endpoint before Electron Builder runs. `forceCodeSigning` makes a missing signature fatal. Before upload, Authenticode verification checks the installer and packaged application executable for a valid trusted chain, exact full Subject, and timestamp certificate with the time-stamping EKU; `signtool verify /pa /all /v` must also succeed. The PFX and password are available only to this build step and never enter the artifact or logs.

Each platform uploads a manifest and only the named DMG/ZIP or NSIS/ZIP files. No updater metadata is generated or uploaded. The Release job has `contents: write` while build jobs remain read-only. It creates a draft, reconciles the exact four manifest assets by SHA-256, skips identical existing assets, and refuses a same-name asset with a different hash. It never uses `--clobber`, leaves existing assets outside the manifest untouched, verifies hashes and source-commit provenance, then publishes the draft. An already published release is a no-op only when its provenance and every declared hash match; missing or changed assets fail closed.

The desktop package carries its own `1.0.5` application version. It does not change the shared pre-release version of the Harness npm family, whose `dsh-v*` tags and registry publication remain independent.

The workflow does not claim Developer ID signing or notarization for macOS. Windows release signing credentials and the expected publisher/timestamp settings are currently absent, so the Windows job intentionally fails before producing release artifacts. The unsigned Windows 1.0.5 local trial is not a release candidate.

## Alternatives considered

**Build both platforms on one runner.** Electron Builder can cross-package some targets, but the staged runtime contains platform-selected dependencies. Native runners keep installation, staging, and packaging on the same operating system and architecture.

**Publish only unpacked application directories.** Directories are useful for local verification but inconvenient GitHub Release downloads. DMG, NSIS, and ZIP cover installation and portable inspection without committing generated output.

**Allow an unsigned Windows Release until credentials arrive.** Rejected because an unsigned installer cannot establish the expected publisher identity and risks misleading users. The workflow fails before publishing until the trusted signing inputs are configured.

## Consequences

A tag must match the unchanged desktop package version and be on `main` history. Failure on either platform prevents publishing, so a Release always has both declared targets. macOS remains ad hoc signed and unnotarized; Windows must pass trusted Authenticode and timestamp verification. Windows signing secrets are scoped to one build step, while release mutation permission remains isolated to the Release job.
