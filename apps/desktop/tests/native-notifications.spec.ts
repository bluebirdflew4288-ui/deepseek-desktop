/** Native calls use conservative copy and release callbacks on disposal. */
import { afterEach, expect, it, vi } from 'vitest'
import { Notification } from 'electron'
import { createNativeNotifications } from '../src/native-notifications.ts'

const native = vi.hoisted(() => ({ badge: vi.fn(), show: vi.fn(), close: vi.fn(), options: vi.fn() }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeNotification extends EventEmitter {
    static isSupported = () => true
    constructor(options: unknown) { super(); native.options(options) }
    show = native.show
    close = native.close
  }
  return { app: { setBadgeCount: native.badge }, Notification: FakeNotification }
})
afterEach(() => { vi.clearAllMocks() })
it('uses native support and the macOS Dock counter without adding task identifiers to system copy', () => {
  const adapter = createNativeNotifications(() => 'zh-CN', vi.fn())
  expect(adapter.supported()).toBe(process.platform === 'darwin' && Notification.isSupported())
  adapter.show({ id: 'private-id', targetId: 'private-target', source: 'harness', kind: 'failed', topLevel: true, occurredAt: 1 }, vi.fn())
  expect(native.options).toHaveBeenCalledWith({ title: 'DeepSeek Desktop', body: 'Harness 任务执行失败' })
  expect(native.show).toHaveBeenCalledOnce()
  adapter.setDockBadge(3)
  if (process.platform === 'darwin') expect(native.badge).toHaveBeenCalledWith(3)
  else expect(native.badge).not.toHaveBeenCalled()
  // Zero is the documented clear signal and must reach the native call as zero.
  adapter.setDockBadge(0)
  if (process.platform === 'darwin') expect(native.badge).toHaveBeenLastCalledWith(0)
  adapter.dispose()
  expect(native.close).toHaveBeenCalledOnce()
})
