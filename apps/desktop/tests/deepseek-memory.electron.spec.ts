import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, type ElectronApplication } from 'playwright'
import { describe, expect, it } from 'vitest'
import { assertFixtureImportsResolve } from './electron-fixture-artifacts.ts'

interface MemoryFixture {
  status: () => { phase: string; message?: string }
  extensionIds: () => { chat: string[]; harness: string[] }
  request: (message: unknown) => Promise<unknown>
  openManager: () => Promise<void>
  openRenderedFallback: (html: string, failures?: number) => Promise<void>
  renderedFallbackState: () => Promise<{
    text: string
    requests: unknown[]
    elements: Array<{ connected: boolean; display: string; siblings: number }>
  }>
  replaceRenderedFallback: (html: string) => Promise<void>
  grantCompletionAuth: (id?: string) => Promise<void>
  anchorAlive: () => boolean
  destroyHost: () => void
}

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureRoot = resolve(desktopRoot, 'tests/fixtures/deepseek-memory-app')
const extensionRoot = resolve(desktopRoot, 'resources/deepseek-memory')
const extensionId = 'gnidildjjigkpideacmahnfagflchfpk'

async function launch(userData: string, extensionPath = extensionRoot): Promise<ElectronApplication> {
  assertFixtureImportsResolve(resolve(fixtureRoot, 'main.mjs'))
  return _electron.launch({
    args: [fixtureRoot],
    cwd: desktopRoot,
    env: {
      ...process.env,
      DSH_MEMORY_FIXTURE_USER_DATA: userData,
      DSH_MEMORY_FIXTURE_EXTENSION: extensionPath,
    },
  })
}

async function fixture<T>(
  application: ElectronApplication,
  method: keyof MemoryFixture,
  args: unknown[] = [],
): Promise<T> {
  return application.evaluate(async (_electron, input) => {
    const api = (globalThis as typeof globalThis & { __dshMemoryFixture?: MemoryFixture }).__dshMemoryFixture
    if (!api) throw new Error('DeepSeek Memory fixture is unavailable')
    const target = api[input.method]
    return await (target as (...values: unknown[]) => T)(...input.args)
  }, { method, args })
}

describe('DeepSeek Memory Electron lifecycle', () => {
  it('persists, augments, manages, exports and imports without entering the Harness session', { timeout: 45_000 }, async () => {
    const userData = await mkdtemp(join(tmpdir(), 'dsh-memory-electron-'))
    const relocated = await mkdtemp(join(tmpdir(), 'dsh-memory-relocated-'))
    const firstExtension = join(relocated, 'first/deepseek-memory')
    const secondExtension = join(relocated, 'second/deepseek-memory')
    let application: ElectronApplication | undefined
    try {
      await cp(extensionRoot, firstExtension, { recursive: true })
      await cp(extensionRoot, secondExtension, { recursive: true })
      application = await launch(userData, firstExtension)
      await expect.poll(async () => (await fixture<ReturnType<MemoryFixture['status']>>(application!, 'status')).phase, { timeout: 10_000 }).toBe('ready')
      expect(await fixture(application, 'extensionIds')).toEqual({
        chat: [extensionId],
        harness: [],
      })
      await fixture(application, 'request', [{
        type: 'SAVE_MEMORY',
        payload: {
          type: 'user',
          name: 'Memory E2E 测试代号',
          content: '我的 Memory E2E 测试代号是 ORBIT-482。',
          description: 'Memory E2E 测试代号',
          tags: ['memory-e2e', '代号'],
          pinned: true,
        },
      }])
      await fixture(application, 'request', [{
        type: 'MEMORY_AUTO_SAVE',
        payload: {
          text: '<memory_save>{"type":"feedback","name":"代码缩进偏好","content":"我的临时代码风格偏好是四空格缩进。","tags":["代码风格","缩进"]}</memory_save>',
        },
      }])
      const augmented = await fixture(application, 'request', [{
        type: 'AUGMENT_PROMPT',
        payload: { prompt: '我的 Memory E2E 测试代号是什么？' },
      }]) as { prompt: string }
      expect(augmented.prompt).toContain('ORBIT-482')
      await application.close()

      application = await launch(userData, secondExtension)
      await expect.poll(async () => (await fixture<ReturnType<MemoryFixture['status']>>(application!, 'status')).phase, { timeout: 10_000 }).toBe('ready')
      const memories = await fixture(application, 'request', [{ type: 'GET_MEMORIES' }]) as Array<{ id: number; content: string }>
      expect(memories.some(memory => memory.content.includes('ORBIT-482'))).toBe(true)
      expect(memories.some(memory => memory.content.includes('四空格缩进'))).toBe(true)

      await fixture(application, 'openManager')
      const manager = application.windows().find(page => page.url().endsWith('/manager.html'))
      if (!manager) throw new Error('DeepSeek Memory manager window is unavailable')
      await expect.poll(() => manager.locator('#summary').textContent()).toContain('2 条本地记忆')
      expect(await manager.locator('body').textContent()).toContain('ORBIT-482')

      const exported = await fixture(application, 'request', [{ type: 'EXPORT_MEMORY_JSON' }]) as string
      for (const memory of memories) {
        expect(memory.id).toBeTypeOf('number')
        await fixture(application, 'request', [{ type: 'DELETE_MEMORY', payload: { id: memory.id } }])
      }
      expect(await fixture(application, 'request', [{ type: 'GET_MEMORIES' }])).toEqual([])
      await fixture(application, 'request', [{ type: 'IMPORT_MEMORY_JSON', payload: { text: exported } }])
      const restored = await fixture(application, 'request', [{ type: 'GET_MEMORIES' }]) as Array<{ content: string }>
      expect(restored.some(memory => memory.content.includes('ORBIT-482'))).toBe(true)
    } finally {
      await application?.close().catch(() => undefined)
      await rm(userData, { recursive: true, force: true })
      await rm(relocated, { recursive: true, force: true })
    }
  })

  it('contains a host failure without terminating the desktop surface', { timeout: 30_000 }, async () => {
    const userData = await mkdtemp(join(tmpdir(), 'dsh-memory-failure-'))
    let application: ElectronApplication | undefined
    try {
      application = await launch(userData)
      await expect.poll(async () => (await fixture<ReturnType<MemoryFixture['status']>>(application!, 'status')).phase, { timeout: 10_000 }).toBe('ready')
      await fixture(application, 'destroyHost')
      await expect.poll(async () => (await fixture<ReturnType<MemoryFixture['status']>>(application!, 'status')).phase, { timeout: 10_000 }).toBe('failed')
      expect(await fixture(application, 'anchorAlive')).toBe(true)
      expect(await fixture(application, 'extensionIds')).toEqual({ chat: [], harness: [] })
    } finally {
      await application?.close().catch(() => undefined)
      await rm(userData, { recursive: true, force: true })
    }
  })

  it('keeps model-proposed updates and deletes out of local storage and isolates an invalid save', { timeout: 30_000 }, async () => {
    const userData = await mkdtemp(join(tmpdir(), 'dsh-memory-automatic-safety-'))
    let application: ElectronApplication | undefined
    try {
      application = await launch(userData)
      await expect.poll(async () => (await fixture<ReturnType<MemoryFixture['status']>>(application!, 'status')).phase, { timeout: 10_000 }).toBe('ready')
      const saved = await fixture(application, 'request', [{
        type: 'SAVE_MEMORY',
        payload: {
          type: 'user',
          name: '受保护记忆',
          content: '这条记忆只能由本地管理器编辑或删除。',
          tags: ['安全'],
          pinned: true,
        },
      }]) as { id: number }

      const automatic = await fixture(application, 'request', [{
        type: 'MEMORY_AUTO_SAVE',
        payload: {
          text: [
            `<memory_update>{"id":${saved.id},"content":"不应写入"}</memory_update>`,
            `<memory_delete>{"id":${saved.id}}</memory_delete>`,
            '<memory_save>{"type":"invalid","name":"无效","content":"无效类型","tags":[]}</memory_save>',
            '<memory_save>{"type":"feedback","name":"有效新增","content":"后续有效调用仍会保存。","tags":["容错"]}</memory_save>',
          ].join(''),
        },
      }]) as { actions: Array<{ name: string; id: number }> }

      expect(automatic.actions).toHaveLength(1)
      expect(automatic.actions[0]?.name).toBe('memory_save')
      const memories = await fixture(application, 'request', [{ type: 'GET_MEMORIES' }]) as Array<{ id: number; content: string }>
      expect(memories).toHaveLength(2)
      expect(memories.find(memory => memory.id === saved.id)?.content).toBe('这条记忆只能由本地管理器编辑或删除。')
      expect(memories.some(memory => memory.content === '后续有效调用仍会保存。')).toBe(true)
    } finally {
      await application?.close().catch(() => undefined)
      await rm(userData, { recursive: true, force: true })
    }
  })

  it('saves and hides only rendered assistant memory calls without duplicate delivery', { timeout: 30_000 }, async () => {
    const userData = await mkdtemp(join(tmpdir(), 'dsh-memory-rendered-fallback-'))
    let application: ElectronApplication | undefined
    try {
      application = await launch(userData)
      await expect.poll(async () => (await fixture<ReturnType<MemoryFixture['status']>>(application!, 'status')).phase, { timeout: 10_000 }).toBe('ready')
      const userCall = '<memory_save>{"type":"user","name":"用户原文","content":"不得扫描用户消息。","tags":[]}</memory_save>'
      const oldAssistantCall = '<memory_save>{"type":"topic","name":"旧回复","content":"旧回复只隐藏，不补写。","tags":[]}</memory_save>'
      const currentAssistantCall = '<memory_save>{"type":"reference","name":"当前回复","content":"当前回复走渲染兜底。","tags":["兜底"]}</memory_save>'
      const reasoningCall = '<memory_save>{"type":"topic","name":"推理块","content":"不得扫描推理块。","tags":[]}</memory_save>'
      const html = [
        `<div class="ds-message" data-message-author-role="assistant"><div class="ds-markdown">${oldAssistantCall.replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</div></div>`,
        `<div class="ds-message d29f3d7d" data-message-author-role="user"><div class="ds-markdown">${userCall.replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</div></div>`,
        '<div class="ds-message" data-message-author-role="assistant"><div class="ds-markdown"><p>已保存。</p><p><span>&lt;memory_</span>',
        `<span>save&gt;${currentAssistantCall.slice(currentAssistantCall.indexOf('>') + 1, currentAssistantCall.lastIndexOf('<'))}&lt;/memory_</span><span>save&gt;</span></p></div></div>`,
        `<div class="ds-message" data-message-author-role="assistant"><div class="ds-think-content"><div class="ds-markdown">${reasoningCall.replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</div></div></div>`,
      ].join('')
      await fixture(application, 'openRenderedFallback', [html])
      await fixture(application, 'grantCompletionAuth')
      await fixture(application, 'replaceRenderedFallback', [html])
      await expect.poll(async () => (await fixture<Awaited<ReturnType<MemoryFixture['renderedFallbackState']>>>(application!, 'renderedFallbackState')).requests.length).toBe(1)
      const first = await fixture<Awaited<ReturnType<MemoryFixture['renderedFallbackState']>>>(application, 'renderedFallbackState')
      expect(first.text).toContain(userCall)
      expect(first.text).not.toContain(oldAssistantCall)
      expect(first.text).not.toContain(currentAssistantCall)
      expect(first.text).toContain(reasoningCall)
      expect(first.requests).toEqual([{ type: 'MEMORY_AUTO_SAVE', payload: { text: currentAssistantCall } }])

      await fixture(application, 'replaceRenderedFallback', [html])
      await expect.poll(async () => (await fixture<Awaited<ReturnType<MemoryFixture['renderedFallbackState']>>>(application!, 'renderedFallbackState')).text).not.toContain(currentAssistantCall)
      expect((await fixture<Awaited<ReturnType<MemoryFixture['renderedFallbackState']>>>(application, 'renderedFallbackState')).requests).toHaveLength(1)
    } finally {
      await application?.close().catch(() => undefined)
      await rm(userData, { recursive: true, force: true })
    }
  })

  it('retries a rejected rendered delivery instead of fingerprinting it as saved', { timeout: 40_000 }, async () => {
    const userData = await mkdtemp(join(tmpdir(), 'dsh-memory-rendered-retry-'))
    let application: ElectronApplication | undefined
    try {
      application = await launch(userData)
      await expect.poll(async () => (await fixture<ReturnType<MemoryFixture['status']>>(application!, 'status')).phase, { timeout: 10_000 }).toBe('ready')
      const retriedCall = '<memory_save>{"type":"reference","name":"重试回复","content":"投递被拒后仍要落库。","tags":["兜底"]}</memory_save>'
      const html = `<div class="ds-message" data-message-author-role="assistant"><div class="ds-markdown">${retriedCall.replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</div></div>`
      await fixture(application, 'openRenderedFallback', [html, 1])
      await fixture(application, 'grantCompletionAuth')
      await fixture(application, 'replaceRenderedFallback', [html])
      const expected = [{ type: 'MEMORY_AUTO_SAVE', payload: { text: retriedCall } }]
      await expect.poll(
        async () => (await fixture<Awaited<ReturnType<MemoryFixture['renderedFallbackState']>>>(application!, 'renderedFallbackState')).requests.length,
        { timeout: 20_000 },
      ).toBe(2)
      expect((await fixture<Awaited<ReturnType<MemoryFixture['renderedFallbackState']>>>(application, 'renderedFallbackState')).requests).toEqual([...expected, ...expected])

      await fixture(application, 'replaceRenderedFallback', [html])
      await expect.poll(async () => (await fixture<Awaited<ReturnType<MemoryFixture['renderedFallbackState']>>>(application!, 'renderedFallbackState')).text).not.toContain(retriedCall)
      expect((await fixture<Awaited<ReturnType<MemoryFixture['renderedFallbackState']>>>(application, 'renderedFallbackState')).requests).toHaveLength(2)
    } finally {
      await application?.close().catch(() => undefined)
      await rm(userData, { recursive: true, force: true })
    }
  })

  it('hides a rendered memory_save element in place instead of detaching it', { timeout: 30_000 }, async () => {
    const userData = await mkdtemp(join(tmpdir(), 'dsh-memory-rendered-element-'))
    let application: ElectronApplication | undefined
    try {
      application = await launch(userData)
      await expect.poll(async () => (await fixture<ReturnType<MemoryFixture['status']>>(application!, 'status')).phase, { timeout: 10_000 }).toBe('ready')
      const body = '{"type":"reference","name":"元素回复","content":"真实元素路径保留节点所有权。","tags":["兜底"]}'
      const html = `<div class="ds-message" data-message-author-role="assistant"><div class="ds-markdown"><p>已保存。</p><memory_save>${body}</memory_save></div></div>`
      await fixture(application, 'openRenderedFallback', [html])
      await fixture(application, 'grantCompletionAuth')
      await fixture(application, 'replaceRenderedFallback', [html])
      await expect.poll(async () => (await fixture<Awaited<ReturnType<MemoryFixture['renderedFallbackState']>>>(application!, 'renderedFallbackState')).requests.length).toBe(1)
      const first = await fixture<Awaited<ReturnType<MemoryFixture['renderedFallbackState']>>>(application, 'renderedFallbackState')
      expect(first.requests).toEqual([{ type: 'MEMORY_AUTO_SAVE', payload: { text: `<memory_save>${body}</memory_save>` } }])
      expect(first.elements).toEqual([{ connected: true, display: 'none', siblings: 2 }])
      expect(first.text).toContain('已保存。')

      await fixture(application, 'replaceRenderedFallback', [html])
      await expect.poll(async () => (await fixture<Awaited<ReturnType<MemoryFixture['renderedFallbackState']>>>(application!, 'renderedFallbackState')).elements[0]?.display).toBe('none')
      const rerendered = await fixture<Awaited<ReturnType<MemoryFixture['renderedFallbackState']>>>(application, 'renderedFallbackState')
      expect(rerendered.elements).toEqual([{ connected: true, display: 'none', siblings: 2 }])
      expect(rerendered.requests).toHaveLength(1)
    } finally {
      await application?.close().catch(() => undefined)
      await rm(userData, { recursive: true, force: true })
    }
  })

  it('never auto-saves a memory call authored by a confirmed user message', { timeout: 30_000 }, async () => {
    const userData = await mkdtemp(join(tmpdir(), 'dsh-memory-authorship-user-'))
    let application: ElectronApplication | undefined
    try {
      application = await launch(userData)
      await expect.poll(async () => (await fixture<ReturnType<MemoryFixture['status']>>(application!, 'status')).phase, { timeout: 10_000 }).toBe('ready')
      const userPasted = '<memory_save>{"type":"user","name":"用户示例","content":"用户粘贴的示例不得写入长期 Memory。","tags":[]}</memory_save>'
      const assistantCall = '<memory_save>{"type":"reference","name":"助手回复","content":"助手回复证明扫描确实发生过。","tags":[]}</memory_save>'
      const html = [
        `<div class="ds-message" data-message-author-role="user"><div class="ds-markdown">${userPasted.replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</div></div>`,
        `<div class="ds-message" data-message-author-role="assistant"><div class="ds-markdown">${assistantCall.replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</div></div>`,
      ].join('')
      await fixture(application, 'openRenderedFallback', [html])
      await fixture(application, 'grantCompletionAuth')
      await fixture(application, 'replaceRenderedFallback', [html])
      await expect.poll(async () => (await fixture<Awaited<ReturnType<MemoryFixture['renderedFallbackState']>>>(application!, 'renderedFallbackState')).requests.length).toBe(1)
      const state = await fixture<Awaited<ReturnType<MemoryFixture['renderedFallbackState']>>>(application, 'renderedFallbackState')
      expect(state.requests).toEqual([{ type: 'MEMORY_AUTO_SAVE', payload: { text: assistantCall } }])
      expect(state.text).toContain(userPasted)
    } finally {
      await application?.close().catch(() => undefined)
      await rm(userData, { recursive: true, force: true })
    }
  })

  it('hides but never saves a memory call whose authorship is unknown', { timeout: 30_000 }, async () => {
    const userData = await mkdtemp(join(tmpdir(), 'dsh-memory-authorship-unknown-'))
    let application: ElectronApplication | undefined
    try {
      application = await launch(userData)
      await expect.poll(async () => (await fixture<ReturnType<MemoryFixture['status']>>(application!, 'status')).phase, { timeout: 10_000 }).toBe('ready')
      const unknownCall = '<memory_save>{"type":"topic","name":"身份不明","content":"身份不明的消息不得写入长期 Memory。","tags":[]}</memory_save>'
      const html = `<div class="ds-message"><div class="ds-markdown">${unknownCall.replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</div></div>`
      await fixture(application, 'openRenderedFallback', [html])
      await expect.poll(async () => (await fixture<Awaited<ReturnType<MemoryFixture['renderedFallbackState']>>>(application!, 'renderedFallbackState')).text).not.toContain(unknownCall)
      expect((await fixture<Awaited<ReturnType<MemoryFixture['renderedFallbackState']>>>(application, 'renderedFallbackState')).requests).toEqual([])
    } finally {
      await application?.close().catch(() => undefined)
      await rm(userData, { recursive: true, force: true })
    }
  })

  it('treats drifted message classes as unknown without breaking later scans', { timeout: 30_000 }, async () => {
    const userData = await mkdtemp(join(tmpdir(), 'dsh-memory-authorship-drift-'))
    let application: ElectronApplication | undefined
    try {
      application = await launch(userData)
      await expect.poll(async () => (await fixture<ReturnType<MemoryFixture['status']>>(application!, 'status')).phase, { timeout: 10_000 }).toBe('ready')
      const driftedCall = '<memory_save>{"type":"topic","name":"漂移选择器","content":"选择器漂移时不得写入长期 Memory。","tags":[]}</memory_save>'
      const drifted = `<div class="ds-message zz9999aa _0000000"><div class="ds-markdown">${driftedCall.replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</div></div>`
      await fixture(application, 'openRenderedFallback', [drifted])
      await expect.poll(async () => (await fixture<Awaited<ReturnType<MemoryFixture['renderedFallbackState']>>>(application!, 'renderedFallbackState')).text).not.toContain(driftedCall)
      expect((await fixture<Awaited<ReturnType<MemoryFixture['renderedFallbackState']>>>(application, 'renderedFallbackState')).requests).toEqual([])

      const assistantCall = '<memory_save>{"type":"reference","name":"漂移后回复","content":"漂移后确认 assistant 仍可保存。","tags":[]}</memory_save>'
      await fixture(application, 'grantCompletionAuth')
      await fixture(application, 'replaceRenderedFallback', [`${drifted}<div class="ds-message" data-message-author-role="assistant"><div class="ds-markdown">${assistantCall.replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</div></div>`])
      await expect.poll(async () => (await fixture<Awaited<ReturnType<MemoryFixture['renderedFallbackState']>>>(application!, 'renderedFallbackState')).requests.length).toBe(1)
      expect((await fixture<Awaited<ReturnType<MemoryFixture['renderedFallbackState']>>>(application, 'renderedFallbackState')).requests).toEqual([{ type: 'MEMORY_AUTO_SAVE', payload: { text: assistantCall } }])
    } finally {
      await application?.close().catch(() => undefined)
      await rm(userData, { recursive: true, force: true })
    }
  })

  it('hides a rendered assistant memory call without authorization and saves it once authorized', { timeout: 30_000 }, async () => {
    const userData = await mkdtemp(join(tmpdir(), 'dsh-memory-auth-required-'))
    let application: ElectronApplication | undefined
    try {
      application = await launch(userData)
      await expect.poll(async () => (await fixture<ReturnType<MemoryFixture['status']>>(application!, 'status')).phase, { timeout: 10_000 }).toBe('ready')
      const esc = (value: string) => value.replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      const call = '<memory_save>{"type":"reference","name":"实时回复","content":"仅当前 completion 授权后才落库。","tags":["兜底"]}</memory_save>'
      const html = `<div class="ds-message" data-message-author-role="assistant"><div class="ds-markdown">${esc(call)}</div></div>`
      await fixture(application, 'openRenderedFallback', [html])
      await expect.poll(async () => (await fixture<Awaited<ReturnType<MemoryFixture['renderedFallbackState']>>>(application!, 'renderedFallbackState')).text).not.toContain(call)
      expect((await fixture<Awaited<ReturnType<MemoryFixture['renderedFallbackState']>>>(application, 'renderedFallbackState')).requests).toEqual([])

      await fixture(application, 'grantCompletionAuth')
      await fixture(application, 'replaceRenderedFallback', [html])
      await expect.poll(async () => (await fixture<Awaited<ReturnType<MemoryFixture['renderedFallbackState']>>>(application!, 'renderedFallbackState')).requests.length).toBe(1)
      expect((await fixture<Awaited<ReturnType<MemoryFixture['renderedFallbackState']>>>(application, 'renderedFallbackState')).requests).toEqual([{ type: 'MEMORY_AUTO_SAVE', payload: { text: call } }])
    } finally {
      await application?.close().catch(() => undefined)
      await rm(userData, { recursive: true, force: true })
    }
  })

  it('consumes one completion authorization for exactly one save batch', { timeout: 30_000 }, async () => {
    const userData = await mkdtemp(join(tmpdir(), 'dsh-memory-auth-once-'))
    let application: ElectronApplication | undefined
    try {
      application = await launch(userData)
      await expect.poll(async () => (await fixture<ReturnType<MemoryFixture['status']>>(application!, 'status')).phase, { timeout: 10_000 }).toBe('ready')
      const esc = (value: string) => value.replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      const firstCall = '<memory_save>{"type":"reference","name":"首次授权","content":"第一次授权只消费一次。","tags":["a"]}</memory_save>'
      const secondCall = '<memory_save>{"type":"reference","name":"二次授权","content":"需要新的 completion 授权。","tags":["b"]}</memory_save>'
      const htmlA = `<div class="ds-message" data-message-author-role="assistant"><div class="ds-markdown">${esc(firstCall)}</div></div>`
      const htmlB = `<div class="ds-message" data-message-author-role="assistant"><div class="ds-markdown">${esc(secondCall)}</div></div>`
      await fixture(application, 'openRenderedFallback', [htmlA])
      await fixture(application, 'grantCompletionAuth', ['auth-1'])
      await fixture(application, 'replaceRenderedFallback', [htmlA])
      await expect.poll(async () => (await fixture<Awaited<ReturnType<MemoryFixture['renderedFallbackState']>>>(application!, 'renderedFallbackState')).requests.length).toBe(1)

      await fixture(application, 'replaceRenderedFallback', [htmlB])
      await expect.poll(async () => (await fixture<Awaited<ReturnType<MemoryFixture['renderedFallbackState']>>>(application!, 'renderedFallbackState')).text).not.toContain(secondCall)
      expect((await fixture<Awaited<ReturnType<MemoryFixture['renderedFallbackState']>>>(application, 'renderedFallbackState')).requests).toHaveLength(1)

      await fixture(application, 'grantCompletionAuth', ['auth-2'])
      await fixture(application, 'replaceRenderedFallback', [htmlB])
      await expect.poll(async () => (await fixture<Awaited<ReturnType<MemoryFixture['renderedFallbackState']>>>(application!, 'renderedFallbackState')).requests.length).toBe(2)
      const state = await fixture<Awaited<ReturnType<MemoryFixture['renderedFallbackState']>>>(application, 'renderedFallbackState')
      expect(state.requests[1]).toEqual({ type: 'MEMORY_AUTO_SAVE', payload: { text: secondCall } })
    } finally {
      await application?.close().catch(() => undefined)
      await rm(userData, { recursive: true, force: true })
    }
  })

  it('saves only the latest role-less rendered memory call while a completion authorization is live', { timeout: 30_000 }, async () => {
    const userData = await mkdtemp(join(tmpdir(), 'dsh-memory-auth-unknown-latest-'))
    let application: ElectronApplication | undefined
    try {
      application = await launch(userData)
      await expect.poll(async () => (await fixture<ReturnType<MemoryFixture['status']>>(application!, 'status')).phase, { timeout: 10_000 }).toBe('ready')
      const esc = (value: string) => value.replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      const historicalCall = '<memory_save>{"type":"topic","name":"历史无角色","content":"无角色历史消息即使有授权也不得补录。","tags":[]}</memory_save>'
      const liveCall = '<memory_save>{"type":"reference","name":"本地验收标记","content":"生产 DOM 无角色属性时最新消息依赖 completion 授权落库。","tags":[]}</memory_save>'
      const html = [
        `<div class="ds-message"><div class="ds-markdown">${esc(historicalCall)}</div></div>`,
        `<div class="ds-message"><div class="ds-markdown">${esc(liveCall)}</div></div>`,
      ].join('')
      await fixture(application, 'openRenderedFallback', [html])
      await fixture(application, 'grantCompletionAuth')
      await fixture(application, 'replaceRenderedFallback', [html])
      await expect.poll(async () => (await fixture<Awaited<ReturnType<MemoryFixture['renderedFallbackState']>>>(application!, 'renderedFallbackState')).requests.length).toBe(1)
      const state = await fixture<Awaited<ReturnType<MemoryFixture['renderedFallbackState']>>>(application, 'renderedFallbackState')
      expect(state.requests).toEqual([{ type: 'MEMORY_AUTO_SAVE', payload: { text: liveCall } }])
      expect(state.text).not.toContain(historicalCall)
      expect(state.text).not.toContain(liveCall)
    } finally {
      await application?.close().catch(() => undefined)
      await rm(userData, { recursive: true, force: true })
    }
  })
})
