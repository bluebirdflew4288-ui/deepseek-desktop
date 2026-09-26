# Agent Note: Keep macOS community install guidance in the DMG

Status: implemented

English | [中文](2026-09-26-macos-community-dmg-guidance.zh.md)

## Problem

The GitHub community build is ad-hoc signed and not notarized, so macOS may require a user confirmation on first launch. The DMG previously contained only the application and the Applications link, leaving users without installation or Gatekeeper guidance at download time. Release Notes also attributed the application source to the workflow context SHA, which can identify release tooling during a recovery dispatch.

## Decision

The DMG uses electron-builder's `dmg.contents` to place the application, `/Applications` link, and UTF-8 `安装指南.txt` at its root. The guide remains under `apps/desktop/release-resources`, outside app resources and `app.asar`; the ZIP layout stays unchanged. The guide describes the ad-hoc signature, absent Developer ID and notarization, and macOS's Finder confirmation path without advising users to disable Gatekeeper.

Release Notes identify the application source from the immutable release tag and identify the release tooling ref separately. The release workflow verifies the DMG's root contents and application identity before uploading artifacts.

The already-published v1.0.5 notes retain their legacy provenance field. Recovery may verify that exact release without changing its notes or assets; later releases require both provenance fields.

## Alternatives considered

**Put the guide in app resources or `app.asar`.** The guide only belongs to the installer experience, so bundling it into the installed app would duplicate release material and alter the signed application unnecessarily.

**Add a guide to the ZIP.** The DMG is the primary guided install path. Modifying the ZIP pipeline would add packaging work without improving the required DMG flow, so the ZIP remains a portable app-only archive.

**Recommend removing quarantine or disabling Gatekeeper.** Those steps weaken system protections and are unnecessary as the default first-launch path; the guide directs users to Finder and macOS Settings instead.

## Consequences

The DMG has an additional visible text file and a checked app-to-Applications layout. The installed application bundle and ZIP contents do not gain the guide. Community builds remain ad-hoc signed and unnotarized; users may still need to confirm first launch through the macOS interface.

## Testing

Packaging tests verify the guide path and configuration. A macOS release gate mounts the DMG, validates its filesystem, checks the root entries, verifies UTF-8 guide content, confirms the application bundle identity and arm64 architecture, and validates the code signature.
