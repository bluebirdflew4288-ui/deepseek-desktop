import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { applicationMenuTemplate } from '../src/application-menu.ts'
import { shellMenuModel } from '../src/shell-menu.ts'

function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap(item => [item, ...(Array.isArray(item.submenu) ? flatten(item.submenu) : [])])
}

describe('platform application menus', () => {
  const model = shellMenuModel({ theme: 'system', locale: 'zh-CN' })
  const actions = {
    memory: vi.fn(), memoryReady: true,
    harness: [{ label: 'Install Harness', click: vi.fn() }],
    settings: [{ label: 'Appearance' }],
  }
  it('keeps product actions and native editing on Windows without macOS commands', () => {
    const items = flatten(applicationMenuTemplate(model, actions, 'win32'))
    const roles = items.map(item => item.role)
    for (const role of ['hide', 'hideOthers', 'unhide', 'showSubstitutions', 'startSpeaking', 'stopSpeaking', 'windowMenu']) {
      expect(roles).not.toContain(role)
    }
    expect(roles).toEqual(expect.arrayContaining(['quit', 'copy', 'paste', 'undo', 'close', 'minimize']))
    expect(items.some(item => item.label === 'Install Harness')).toBe(true)
    expect(items.find(item => item.label === model.strings.manageMemory)?.click).toBeTypeOf('function')
  })
  it('retains macOS native services in the macOS menu', () => {
    const roles = flatten(applicationMenuTemplate(model, actions, 'darwin')).map(item => item.role)
    expect(roles).toEqual(expect.arrayContaining(['hideOthers', 'showSubstitutions', 'startSpeaking', 'windowMenu']))
  })
})
