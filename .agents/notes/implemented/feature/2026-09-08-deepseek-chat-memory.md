# Agent Note: DeepSeek Chat local Memory

Status: implemented

English | [中文](2026-09-08-deepseek-chat-memory.zh.md)

## Problem

Desktop preserves the official DeepSeek Chat profile across launches, but separate conversations cannot reuse durable user preferences or background facts. Loading the complete DeepSeek++ browser extension would add unsupported MV3 service-worker behavior, broad browser capabilities, unrelated dependencies, and permissions that do not belong in the dual-mode desktop product. Memory must also remain isolated from Harness and must not make either primary mode depend on an optional enhancement.

## Decision

Desktop ships an Electron-specific, dependency-free Memory-only derivative under `apps/desktop/resources/deepseek-memory/`. The derivative retains the DeepSeek++ Memory record shape and IndexedDB migration concepts, selection and prompt augmentation behavior, a direct XML save protocol, completion request/response interception, management operations, and JSON import/export behavior. Its Apache-2.0 license and modification notice ship beside the extension.

The main process owns `DeepSeekMemoryRuntime` in `apps/desktop/src/deepseek-memory-extension.ts`. At every boot it validates the narrow MV3 manifest, loads the unpacked extension only into `persist:dsh-deepseek-chat`, verifies the expected extension ID, and keeps a hidden sandboxed extension page alive as the runtime host. Harness remains on `defaultSession`, where the extension is absent. Extension load and host failures are contained and reported without terminating Chat, Harness, or the desktop process.

### Identity and persistence

The manifest carries a fixed public RSA key whose Chromium-derived ID is `gnidildjjigkpideacmahnfagflchfpk`. The main process derives and checks that ID before accepting the resource, then checks Electron's loaded result. Memory uses IndexedDB database `DeepSeekPP` at the extension origin. A stable key makes that origin independent of the unpacked resource path, application location, and packaging output path.

### Request boundary

Two content scripts run only on `https://chat.deepseek.com/*`: an isolated-world bridge and a main-world request hook. The hook augments only a new conversation's first completion request and fails open to the original request when Memory is unavailable. Selected records are encoded as untrusted JSON data with structural marker characters escaped. Completion responses are scanned linearly for bounded direct `memory_save` XML calls. The isolated content script also treats the latest rendered message that is not confirmed as user as a bounded fallback: it forwards complete calls through the same append-only host path, removes those calls from visible Markdown, and fingerprints only host-accepted calls, so SPA re-renders do not resend a delivered call while a rejected delivery is retried rather than dropped. Saving requires a short-lived completion authorization posted by the request hook for the current response and consumed by one accepted save. A role-less latest response can save only while that authorization is live; confirmed user messages remain untouched, reasoning blocks are excluded, and messages without authorization may hide technical tags but never backfill historical Memory. Model output can append a valid record but cannot edit or delete existing Memory. The manifest has no extension API permissions, optional permissions, background worker, or arbitrary host access.

### User operations

The native application and tray menus open an extension-origin manager for list, search, filter, add, edit, delete, and pin operations. Editing and deletion are user-initiated manager operations rather than model-authorized mutations. Export and import use Electron save/open dialogs. Import validates the document and commits its records in one IndexedDB transaction. Clearing Chat data warns that the operation removes login state and local Memory, so users can export JSON first.

## Alternatives considered

- Loading unmodified DeepSeek++ was rejected because Electron does not provide its complete MV3 background and Chrome API environment, while its broad feature set and dependency closure exceed the requested Memory scope.
- Compatibility stubs around the complete background were rejected because hidden unsupported modules would still execute and ship.
- A desktop-owned database was rejected for this phase because the proven same-session extension host preserves the existing Memory model with a smaller compatibility boundary.
- Loading the extension in `defaultSession` was rejected because that would expose Memory to Harness and couple two otherwise independent modes.
- Deriving identity from the unpacked path was rejected because rebuilds, app moves, and upgrades could create a new extension origin and orphan IndexedDB data.

## Consequences

Chat gains durable local Memory and explicit JSON portability without new npm production dependencies. Automatic Memory is deliberately append-only: correction and deletion require the local manager, preventing untrusted model output from silently mutating existing records. The shipped fork excludes MCP, shell, native messaging, browser control, debugger, OAuth, WebDAV/cloud sync, Pyodide, offscreen, floating chat, automation, pet, theme enhancement, web search/fetch, official API, and arbitrary-host permissions. The fixed extension ID becomes a persisted-data contract and must not change without a migration. Clearing the Chat partition also clears Memory. Desktop packaging materializes the checksummed native Electron runtime before Electron Builder runs, so a clean installation does not depend on a prewarmed cache. The request adapter and rendered fallback depend on the official DeepSeek completion and assistant-DOM contracts, so real-account release validation must cover injection, tool parsing, automatic save, visible-label removal, recall, login persistence, full quit/restart, JSON recovery, and Harness isolation in addition to the local Electron lifecycle suite.
