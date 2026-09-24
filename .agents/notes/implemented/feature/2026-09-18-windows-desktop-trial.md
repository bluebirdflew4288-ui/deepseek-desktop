# Agent Note: Windows Desktop local trial

Status: implemented

English | [中文](2026-09-18-windows-desktop-trial.zh.md)

## Problem

The macOS Desktop shell contains menu roles, tray artwork, and process recovery commands that do not provide a usable Windows trial. Having a Windows packaging target alone does not establish runtime compatibility.

## Decision

Windows uses the shared product actions with platform-specific native menu roles, a color tray icon, native caption controls, and restoration of minimized windows. Closing a window keeps Desktop in the tray. macOS retains its existing roles and template image.

The local `dist:win` command produces unsigned x64 NSIS and ZIP artifacts with publication disabled. NSIS installs per user and preserves application data on uninstall. Runtime staging supplies pinned npm; the package check executes it through the Windows application binary.

Managed children receive the Windows environment variables their runtime requires. The parent-death watchdog probes the parent on Windows, where `ppid` does not change after exit. Recovery checks live process command lines for the managed directory and waits rather than killing a persisted PID. Failed recovery blocks all program-changing transactions and clears the launch descriptor until recovery succeeds. Harness user data remains outside these program directories.

Default Windows launches store Desktop preferences and the managed Harness installation under `%USERPROFILE%\\.deepseek-desktop`, outside the encrypted roaming profile location that rejected atomic rename on this host. Electron's resolved user-data path still owns the Chromium Chat profile, login, and Memory. Explicit `--user-data-dir` profiles remain fully isolated and continue to store program files within that profile. On upgrade, validated preferences are copied only if the new state file is absent; the old file and browser profile are retained.

## Alternatives considered

**Reuse the macOS menus and monochrome template image.** Those roles include unavailable Windows actions, and the template image does not provide an appropriate Windows tray icon.

**Terminate processes using recorded PIDs.** A reused PID does not prove ownership. Waiting and refusing recovery preserves unrelated processes at the cost of requiring a restart after a blocker clears.

**Publish after building.** The owner requires several days of local use before deciding whether to publish. Local packaging never authorizes a tag or Release.

## Consequences

Windows gains an installable local trial while sharing the existing Chat, Memory, and Harness boundaries. Menu, lifecycle, actual child-process exit, recovery failure, and Windows npm execution have regression coverage. Live Chat login and sustained Windows use require owner acceptance; macOS GUI behavior cannot be validated on the Windows host. The trial remains unsigned and unpublished.

## 1.0.5 trial status

The 1.0.5 Windows work carries the upstream Chat/Harness notification settings and update card into the Windows shell. Native Windows notifications are enabled alongside macOS, and Harness result polling is no longer restricted to Darwin. Targeted tests cover notification selection, unread state, menu/lifecycle behavior, and update-stage state. The installed trial's notification settings were visible, but no live Chat login or real Harness event was exercised.

The existing managed Harness release still mixes Cordis 4.0.2 / loader 1.0.3 under DSH with Cordis 4.0.4 / loader 1.0.5 at the install root. This reproduced `entry._await is not a function` in the default profile. A package-only synthetic profile passed startup with the old pair unified and reached the HTTP token fence; the clean npm staging installation of the proposed override did not complete on this host. Initial Desktop GUI verification ran `prepareProfile()`, which rewrote the default profile's `cordis.yml` to an empty YAML list; later offline work did not modify the installed managed version or profile. See the dated trial record for build provenance, hashes, and the exact acceptance boundary.
