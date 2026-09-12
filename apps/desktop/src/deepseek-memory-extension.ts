/** Electron lifecycle and native file-dialog integration for DeepSeek Memory. */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BrowserWindow,
  dialog,
  type BrowserWindowConstructorOptions,
  type OpenDialogOptions,
  type Session,
} from 'electron'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { CHAT_PARTITION } from './chat-navigation.ts'

export const DEEPSEEK_MEMORY_EXTENSION_ID = 'gnidildjjigkpideacmahnfagflchfpk'
export const DEEPSEEK_MEMORY_HOST_PERMISSION = 'https://chat.deepseek.com/*'
const MAX_IMPORT_BYTES = 8 * 1024 * 1024

const ALLOWED_MANIFEST_KEYS = new Set([
  'manifest_version',
  'name',
  'description',
  'version',
  'key',
  'host_permissions',
  'content_scripts',
  'permissions',
  'optional_permissions',
  'optional_host_permissions',
  'background',
])

interface MemoryManifest {
  readonly manifest_version?: unknown
  readonly name?: unknown
  readonly version?: unknown
  readonly key?: unknown
  readonly host_permissions?: unknown
  readonly permissions?: unknown
  readonly optional_permissions?: unknown
  readonly optional_host_permissions?: unknown
  readonly background?: unknown
  readonly content_scripts?: unknown
}

/** Detached health report for the optional Memory surface. */
export type DeepSeekMemoryStatus =
  | { readonly phase: 'idle' | 'loading' | 'ready' }
  | { readonly phase: 'failed'; readonly message: string }

/** Compute Chromium's path-independent extension id from a manifest public key. */
export function extensionIdFromManifestKey(key: string): string {
  const digest = createHash('sha256').update(Buffer.from(key, 'base64')).digest().subarray(0, 16)
  return [...digest].flatMap(byte => [byte >> 4, byte & 0x0f])
    .map(value => String.fromCharCode('a'.charCodeAt(0) + value)).join('')
}

/**
 * Reject permissions or entrypoints outside the fixed Memory-only design.
 * @param path - absolute directory containing the unpacked extension.
 * @returns the parsed manifest after all security invariants pass.
 */
export async function validateDeepSeekMemoryExtension(path: string): Promise<MemoryManifest> {
  const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8')) as MemoryManifest
  for (const key of Object.keys(manifest)) {
    if (!ALLOWED_MANIFEST_KEYS.has(key)) throw new Error(`DeepSeek Memory manifest contains unsupported field ${key}`)
  }
  if (manifest.manifest_version !== 3 || typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    throw new Error('DeepSeek Memory requires a named, versioned MV3 manifest')
  }
  if (typeof manifest.key !== 'string' || extensionIdFromManifestKey(manifest.key) !== DEEPSEEK_MEMORY_EXTENSION_ID) {
    throw new Error('DeepSeek Memory manifest key does not produce the production extension id')
  }
  if (!Array.isArray(manifest.host_permissions)
    || manifest.host_permissions.length !== 1
    || manifest.host_permissions[0] !== DEEPSEEK_MEMORY_HOST_PERMISSION) {
    throw new Error('DeepSeek Memory host permission must be exactly the official Chat origin')
  }
  for (const [name, value] of Object.entries({
    permissions: manifest.permissions,
    optional_permissions: manifest.optional_permissions,
    optional_host_permissions: manifest.optional_host_permissions,
  })) {
    if (value !== undefined && (!Array.isArray(value) || value.length > 0)) {
      throw new Error(`DeepSeek Memory manifest must not request ${name}`)
    }
  }
  if (manifest.background !== undefined) {
    throw new Error('DeepSeek Memory uses the desktop-owned host page, not a background worker')
  }
  if (!Array.isArray(manifest.content_scripts) || manifest.content_scripts.length !== 2) {
    throw new Error('DeepSeek Memory requires exactly the main-world hook and isolated bridge')
  }
  const [mainWorld, isolatedWorld] = manifest.content_scripts as Record<string, unknown>[]
  const exactChatMatch = (value: unknown): boolean => (
    Array.isArray(value) && value.length === 1 && value[0] === DEEPSEEK_MEMORY_HOST_PERMISSION
  )
  const exactScript = (entry: Record<string, unknown> | undefined, file: string, world?: string): boolean => {
    if (entry === undefined) return false
    const allowedKeys = world === undefined ? new Set(['matches', 'js', 'run_at']) : new Set(['matches', 'js', 'run_at', 'world'])
    if (Object.keys(entry).some(key => !allowedKeys.has(key))) return false
    return exactChatMatch(entry.matches)
      && Array.isArray(entry.js)
      && entry.js.length === 1
      && entry.js[0] === file
      && entry.run_at === 'document_start'
      && (world === undefined ? entry.world === undefined : entry.world === world)
  }
  if (!exactScript(mainWorld, 'main-world.js', 'MAIN') || !exactScript(isolatedWorld, 'content.js')) {
    throw new Error('DeepSeek Memory content scripts must use the fixed Chat-only bridge configuration')
  }
  return manifest
}

/** Paths and Electron factories supplied by the production composition root. */
export interface DeepSeekMemoryRuntimeOptions {
  readonly extensionPath: string
  readonly chatSession: Session
  readonly createWindow?: (options: BrowserWindowConstructorOptions) => BrowserWindow
  readonly reportError: (error: unknown) => void
}

/** Persistent Memory-only extension runtime owned independently from Chat/Harness surfaces. */
export class DeepSeekMemoryRuntime {
  private readonly options: DeepSeekMemoryRuntimeOptions
  private extensionId: string | undefined
  private extensionUrl: string | undefined
  private hostWindow: BrowserWindow | undefined
  private managerWindow: BrowserWindow | undefined
  private startPromise: Promise<void> | undefined
  private stopping = false
  private lifecycleGeneration = 0
  private state: DeepSeekMemoryStatus = { phase: 'idle' }

  constructor(options: DeepSeekMemoryRuntimeOptions) {
    this.options = options
  }

  status(): DeepSeekMemoryStatus {
    return { ...this.state }
  }

  start(): Promise<void> {
    if (this.state.phase === 'failed') this.startPromise = undefined
    if (this.startPromise !== undefined) return this.startPromise
    const generation = ++this.lifecycleGeneration
    this.startPromise = this.startOnce(generation).catch((error: unknown) => {
      if (generation !== this.lifecycleGeneration || this.stopping) return
      this.containFailedStart()
      this.state = { phase: 'failed', message: error instanceof Error ? error.message : String(error) }
      this.options.reportError(error)
    })
    return this.startPromise
  }

  private async startOnce(generation: number): Promise<void> {
    this.state = { phase: 'loading' }
    await validateDeepSeekMemoryExtension(this.options.extensionPath)
    if (generation !== this.lifecycleGeneration || this.stopping) return
    const extension = await this.options.chatSession.extensions.loadExtension(this.options.extensionPath)
    if (this.isStaleGeneration(generation)) {
      this.options.chatSession.extensions.removeExtension(extension.id)
      return
    }
    if (extension.id !== DEEPSEEK_MEMORY_EXTENSION_ID) {
      this.options.chatSession.extensions.removeExtension(extension.id)
      throw new Error(`DeepSeek Memory loaded with unexpected extension id ${extension.id}`)
    }
    this.extensionId = extension.id
    this.extensionUrl = extension.url
    const createWindow = this.options.createWindow ?? (options => new BrowserWindow(options))
    const host = createWindow(this.windowOptions({ show: false, width: 320, height: 240, skipTaskbar: true }))
    this.hostWindow = host
    host.webContents.on('render-process-gone', (_event, details) => {
      if (!this.stopping && this.hostWindow === host) {
        this.fail(new Error(`DeepSeek Memory host stopped: ${details.reason}`))
      }
    })
    host.on('closed', () => {
      if (!this.stopping && this.hostWindow === host) {
        this.fail(new Error('DeepSeek Memory host window closed unexpectedly'))
      }
    })
    await host.loadURL(`${extension.url}host.html`)
    if (this.isStaleGeneration(generation)) {
      if (!host.isDestroyed()) host.destroy()
      if (this.extensionId === extension.id) this.options.chatSession.extensions.removeExtension(extension.id)
      return
    }
    await host.webContents.executeJavaScript(
      `new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const check = () => {
          if (document.documentElement.dataset.ready === 'true') resolve(true);
          else if (Date.now() >= deadline) reject(new Error('Memory host readiness timed out'));
          else setTimeout(check, 25);
        };
        check();
      })`,
      true,
    )
    if (this.isStaleGeneration(generation)) {
      if (!host.isDestroyed()) host.destroy()
      if (this.extensionId === extension.id) this.options.chatSession.extensions.removeExtension(extension.id)
      return
    }
    this.state = { phase: 'ready' }
  }

  private windowOptions(overrides: BrowserWindowConstructorOptions): BrowserWindowConstructorOptions {
    return {
      ...overrides,
      webPreferences: {
        partition: CHAT_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    }
  }

  private fail(error: Error): void {
    if (this.stopping) return
    const manager = this.managerWindow
    const host = this.hostWindow
    const extensionId = this.extensionId
    this.managerWindow = undefined
    this.hostWindow = undefined
    this.extensionId = undefined
    this.extensionUrl = undefined
    this.state = { phase: 'failed', message: error.message }
    if (manager !== undefined && !manager.isDestroyed()) manager.destroy()
    if (host !== undefined && !host.isDestroyed()) host.destroy()
    if (extensionId !== undefined) this.options.chatSession.extensions.removeExtension(extensionId)
    this.options.reportError(error)
  }

  private isStaleGeneration(generation: number): boolean {
    return generation !== this.lifecycleGeneration || this.stopping
  }

  private containFailedStart(): void {
    this.stopping = true
    try {
      const manager = this.managerWindow
      const host = this.hostWindow
      this.managerWindow = undefined
      this.hostWindow = undefined
      if (manager !== undefined && !manager.isDestroyed()) manager.destroy()
      if (host !== undefined && !host.isDestroyed()) host.destroy()
      if (this.extensionId !== undefined) {
        this.options.chatSession.extensions.removeExtension(this.extensionId)
      }
      this.extensionId = undefined
      this.extensionUrl = undefined
    } finally {
      this.stopping = false
    }
  }

  private readyHost(): BrowserWindow {
    if (this.state.phase !== 'ready' || this.hostWindow === undefined || this.hostWindow.isDestroyed()) {
      throw new Error(this.state.phase === 'failed' ? this.state.message : 'DeepSeek Memory is unavailable')
    }
    return this.hostWindow
  }

  async openManager(): Promise<void> {
    await this.start()
    if (this.managerWindow !== undefined && !this.managerWindow.isDestroyed()) {
      this.managerWindow.show()
      this.managerWindow.focus()
      return
    }
    if (this.extensionUrl === undefined) throw new Error('DeepSeek Memory is unavailable')
    const createWindow = this.options.createWindow ?? (options => new BrowserWindow(options))
    const manager = createWindow(this.windowOptions({
      show: false,
      width: 760,
      height: 760,
      minWidth: 560,
      minHeight: 520,
      title: 'DeepSeek Memory',
    }))
    this.managerWindow = manager
    manager.on('closed', () => {
      if (this.managerWindow === manager) this.managerWindow = undefined
    })
    manager.webContents.setWindowOpenHandler(({ url }) => {
      if (url === 'dsh-memory-action://export') void this.exportWithNativeDialog(manager)
      else if (url === 'dsh-memory-action://import') void this.importWithNativeDialog(manager)
      return { action: 'deny' }
    })
    try {
      await manager.loadURL(`${this.extensionUrl}manager.html`)
      manager.show()
    } catch (error) {
      if (this.managerWindow === manager) this.managerWindow = undefined
      if (!manager.isDestroyed()) manager.destroy()
      throw error
    }
  }

  async exportWithNativeDialog(parent?: BrowserWindow): Promise<void> {
    const host = this.readyHost()
    const owner = parent ?? BrowserWindow.getFocusedWindow()
    const dialogOptions = {
      title: '导出 DeepSeek Memory',
      defaultPath: `DeepSeek_Memory_${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    }
    const result = owner === null
      ? await dialog.showSaveDialog(dialogOptions)
      : await dialog.showSaveDialog(owner, dialogOptions)
    if (result.canceled) return
    const filePath = result.filePath
    const json = await host.webContents.executeJavaScript('globalThis.deepseekMemoryHost.exportJson()', true) as string
    await writeFileAtomic(filePath, json, { mode: 0o600 })
  }

  async importWithNativeDialog(parent?: BrowserWindow): Promise<void> {
    const host = this.readyHost()
    const owner = parent ?? BrowserWindow.getFocusedWindow()
    const dialogOptions: OpenDialogOptions = {
      title: '导入 DeepSeek Memory',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    }
    const result = owner === null
      ? await dialog.showOpenDialog(dialogOptions)
      : await dialog.showOpenDialog(owner, dialogOptions)
    if (result.canceled) return
    const filePath = result.filePaths[0]
    if (!filePath) return
    const content = await readFile(filePath)
    if (content.byteLength > MAX_IMPORT_BYTES) throw new Error('Memory import exceeds the 8 MiB limit')
    const encoded = content.toString('base64')
    await host.webContents.executeJavaScript(
      `globalThis.deepseekMemoryHost.importJson(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob('${encoded}'), character => character.charCodeAt(0))))`,
      true,
    )
    this.managerWindow?.webContents.reload()
  }

  stop(): Promise<void> {
    this.lifecycleGeneration += 1
    this.stopping = true
    try {
      const manager = this.managerWindow
      const host = this.hostWindow
      this.managerWindow = undefined
      this.hostWindow = undefined
      if (manager !== undefined && !manager.isDestroyed()) manager.destroy()
      if (host !== undefined && !host.isDestroyed()) host.destroy()
      if (this.extensionId !== undefined) {
        this.options.chatSession.extensions.removeExtension(this.extensionId)
      }
      this.extensionId = undefined
      this.extensionUrl = undefined
      this.startPromise = undefined
      this.state = { phase: 'idle' }
    } finally {
      this.stopping = false
    }
    return Promise.resolve()
  }
}
