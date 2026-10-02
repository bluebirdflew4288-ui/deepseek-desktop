# Agent Note: Desktop releases verify runtime identity and platform readiness

Status: implemented

English | [中文](2026-10-02-desktop-release-runtime-and-platform-validation.zh.md)

## Problem

A Desktop release built with a different Electron version from the accepted local runtime cannot reuse that runtime's acceptance evidence. Native packaging success also does not establish that a platform's update functionality works.

## Decision

The Desktop package and lockfile pin Electron 44.0.0, matching the accepted Mac runtime. Release builds execute the installed and packaged binaries in Electron Node mode and compare process.versions.electron with the package pin. A mismatch or failed probe blocks artifact upload. Harness staging uses the published dependency closure except for the exact legacy release 0.1.5-rc.2; its Cordis override does not constrain later official updates. Startup diagnostics classify recognized failures without retaining raw Host output or credentials.

Public Desktop releases currently declare only mac-arm64. Windows update functionality is awaiting repair and acceptance, so Windows packaging tooling remains available but the release workflow does not build or publish Windows artifacts. The release synchronizer requires explicit platforms, verifies every declared asset and rejects undeclared assets before publication. Release notes derive the Electron version from the same source package and disclose the Windows pause.

This partially supersedes the platform requirements in the [tag-driven release decision](2026-08-17-tag-driven-desktop-github-releases.md); immutable tags, version matching, source provenance and draft-before-verification remain applicable. Normal tag runs use the tag's source and tooling together; there is no main-source overlay or legacy recovery dispatch in the current workflow.

## Alternatives considered

**Publish both platforms whenever CI packaging succeeds.** Rejected because packaging does not prove update functionality or user acceptance.

**Replace assets behind an existing tag.** Rejected because downloads and hashes would cease to identify one immutable release; runtime corrections use a new App version and tag.

**Only edit the Electron dependency string.** Rejected because packaging can use an already materialized Electron distribution; executable probes verify what actually ships.

## Consequences

Mac releases remain ad hoc signed and unnotarized. Desktop App updates require downloading a new release; Harness updates continue to download official npm packages. Windows publication resumes only after its update functionality is repaired and accepted, with an explicit workflow/platform declaration change. No Node environment manager, automatic source merge or development-environment redesign is introduced.

## Verification

Runtime tests reject the earlier runtime and incomplete probes. Manifest synchronization exercises both Mac-only and explicit two-platform sets, and rejects undeclared Windows assets. Native release jobs verify the packaged runtime, npm launchers, DMG identity and signatures. A disposable official Harness installation and health check establish compatibility without modifying the installed user profile.
