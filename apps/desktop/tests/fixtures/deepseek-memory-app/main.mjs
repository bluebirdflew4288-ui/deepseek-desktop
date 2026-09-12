import { app, BrowserWindow, session } from 'electron'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { DeepSeekMemoryRuntime } from '../../../lib/types/deepseek-memory-extension.js'

const userData = process.env.DSH_MEMORY_FIXTURE_USER_DATA
const extensionPath = process.env.DSH_MEMORY_FIXTURE_EXTENSION
if (!userData || !extensionPath) throw new Error('DeepSeek Memory fixture paths are required')
app.setPath('userData', userData)

let runtime
let anchor
let renderedFallbackWindow
let quitReleased = false

function memoryHost() {
  const host = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/host.html'))
  if (!host) throw new Error('Memory host is unavailable')
  return host
}

async function request(message) {
  const source = JSON.stringify(message)
  return memoryHost().webContents.executeJavaScript(`globalThis.deepseekMemoryHost.request(${source})`, true)
}

async function openRenderedFallback(html, failures = 0) {
  renderedFallbackWindow?.destroy()
  renderedFallbackWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: false,
      sandbox: true,
      webSecurity: true,
    },
  })
  await renderedFallbackWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  const result = await renderedFallbackWindow.webContents.executeJavaScript(`
    try {
      globalThis.__memoryRequests = [];
      globalThis.__memoryFailures = ${JSON.stringify(failures)};
      const nativePostMessage = window.postMessage.bind(window);
      window.postMessage = (message, targetOrigin) => nativePostMessage(message, targetOrigin === 'null' ? '*' : targetOrigin);
      globalThis.chrome = {
        runtime: {
          lastError: undefined,
          onMessage: { addListener() {} },
          sendMessage(message, callback) {
            globalThis.__memoryRequests.push(message);
            if (globalThis.__memoryFailures > 0) {
              globalThis.__memoryFailures -= 1;
              globalThis.chrome.runtime.lastError = { message: 'Memory host rejected the delivery' };
              callback(undefined);
            } else {
              globalThis.chrome.runtime.lastError = undefined;
              callback({ ok: true, value: { actions: [] } });
            }
            globalThis.chrome.runtime.lastError = undefined;
          },
        },
      };
      ${await readFile(resolve(extensionPath, 'content.js'), 'utf8')}
      ;({ ok: true });
    } catch (error) {
      ({ ok: false, error: error?.stack ?? String(error) });
    }
  `, true)
  if (!result.ok) throw new Error(result.error)
}

async function renderedFallbackState() {
  if (!renderedFallbackWindow || renderedFallbackWindow.isDestroyed()) throw new Error('Rendered fallback fixture is unavailable')
  return renderedFallbackWindow.webContents.executeJavaScript(`({
    text: document.body.textContent,
    requests: globalThis.__memoryRequests,
    elements: [...document.querySelectorAll('memory_save')].map(element => ({
      connected: element.isConnected,
      display: element.style.display,
      siblings: element.parentElement?.childElementCount ?? 0,
    })),
  })`, true)
}

async function grantCompletionAuth(id = 'auth-1') {
  if (!renderedFallbackWindow || renderedFallbackWindow.isDestroyed()) throw new Error('Rendered fallback fixture is unavailable')
  await renderedFallbackWindow.webContents.executeJavaScript(`
    window.postMessage({ source: 'deepseek-desktop-memory', type: 'DPP_MEMORY_BRIDGE_HELLO', nonce: '0123456789abcdef0123456789abcdef' }, location.origin);
    window.postMessage({ source: 'deepseek-desktop-memory', type: 'DPP_MEMORY_COMPLETION_AUTH', nonce: '0123456789abcdef0123456789abcdef', id: ${JSON.stringify(id)} }, location.origin);
    true
  `, true)
}

async function replaceRenderedFallback(html) {
  if (!renderedFallbackWindow || renderedFallbackWindow.isDestroyed()) throw new Error('Rendered fallback fixture is unavailable')
  await renderedFallbackWindow.webContents.executeJavaScript(`document.body.innerHTML = ${JSON.stringify(html)}`, true)
}

globalThis.__dshMemoryFixture = {
  status: () => runtime.status(),
  extensionIds: () => ({
    chat: session.fromPartition('persist:dsh-deepseek-chat').extensions.getAllExtensions().map(extension => extension.id),
    harness: session.defaultSession.extensions.getAllExtensions().map(extension => extension.id),
  }),
  request,
  openManager: () => runtime.openManager(),
  openRenderedFallback,
  renderedFallbackState,
  replaceRenderedFallback,
  grantCompletionAuth,
  anchorAlive: () => Boolean(anchor && !anchor.isDestroyed()),
  destroyHost: () => memoryHost().destroy(),
}

async function boot() {
  anchor = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  })
  await anchor.loadURL('data:text/html,<title>DeepSeek Memory fixture</title>')
  const chatSession = session.fromPartition('persist:dsh-deepseek-chat')
  runtime = new DeepSeekMemoryRuntime({
    extensionPath: resolve(extensionPath),
    chatSession,
    createWindow: options => new BrowserWindow(options),
    reportError: error => console.error('memory fixture error:', error),
  })
  await runtime.start()
}

app.on('window-all-closed', () => {})
app.on('before-quit', event => {
  if (quitReleased) return
  event.preventDefault()
  void runtime?.stop().finally(() => {
    quitReleased = true
    app.quit()
  })
})
app.whenReady().then(boot).catch(error => {
  console.error('memory fixture startup failed:', error)
  app.exit(1)
})
