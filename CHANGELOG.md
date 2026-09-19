# Changelog

## 1.0.5 - 2026-09-19

- Added desktop notifications for Chat replies and for Harness completion, failure, and action requests, with macOS Dock counts, in-app attention dots, per-source read state, notification accent settings, and suppression while the window is already in the foreground. A notification click restores the window and selects the source mode.
- Added a Harness update card that reports the stages a managed transaction actually reaches (`preparing`, `installing`, `verifying`, `health`) with no inferred percentage, keeps the surfaces underneath usable, and carries the runtime's own verdict on whether the current stage can be cancelled.
- Reported a reinstall of the version already running as itself rather than as an upgrade, and stated that a promoted version takes effect when the Harness is restarted.
- Presented a browser user agent to the official Chat endpoints instead of the Electron default.
- Stated the current rollback boundary in the documentation: rollback restores the selected Harness program version only, not the local data under `~/.dsh`.

## 1.0.4 - 2026-08-28

- Rebuilt the desktop release with the synchronized `sharp` lockfile entry so frozen CI installs succeed on macOS and Windows.

## 1.0.3 - 2026-08-28

- Fixed Windows workspace directory selection under the Electron runtime by using koffi's direct UTF-16 decoder when available.
- Kept the bounded memory-view fallback for older koffi versions.
- Added regression coverage for both decoder paths.
