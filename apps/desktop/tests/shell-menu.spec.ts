/** The shell settings model both the application menu and the tray render. */

import { describe, expect, it } from 'vitest'
import { shellMenuModel, shellSettingsGroups, type DesktopShellPreferences } from '../src/shell-menu.ts'

const ZH: DesktopShellPreferences = { theme: 'system', locale: 'zh-CN' }
const EN_DARK: DesktopShellPreferences = { theme: 'dark', locale: 'en-US' }

function groupOf(prefs: DesktopShellPreferences, index: number) {
  return shellSettingsGroups(prefs)[index]!
}

describe('the appearance group', () => {
  it('presents follow-system first, then the two pinned palettes', () => {
    expect(groupOf(ZH, 0).choices.map(choice => choice.action)).toEqual([
      { kind: 'theme', preference: 'system' },
      { kind: 'theme', preference: 'light' },
      { kind: 'theme', preference: 'dark' },
    ])
  })

  it('marks exactly the current preference', () => {
    expect(groupOf(ZH, 0).choices.map(choice => choice.checked)).toEqual([true, false, false])
    expect(groupOf(EN_DARK, 0).choices.map(choice => choice.checked)).toEqual([false, false, true])
  })

  it('renders its heading and labels in the active locale', () => {
    expect(groupOf(ZH, 0).label).toBe('外观')
    expect(groupOf(ZH, 0).choices.map(choice => choice.label)).toEqual(['跟随系统', '浅色', '深色'])
    expect(groupOf(EN_DARK, 0).label).toBe('Appearance')
    expect(groupOf(EN_DARK, 0).choices.map(choice => choice.label)).toEqual(['Follow System', 'Light', 'Dark'])
  })
})

describe('the language group', () => {
  it('labels each locale in that locale and marks the active one', () => {
    const group = groupOf(ZH, 1)
    expect(group.label).toBe('语言')
    expect(group.choices.map(choice => choice.label)).toEqual(['简体中文', 'English'])
    expect(group.choices.map(choice => choice.checked)).toEqual([true, false])
    expect(groupOf(EN_DARK, 1).choices.map(choice => choice.checked)).toEqual([false, true])
  })

  it('carries the locale choice as its action', () => {
    expect(groupOf(ZH, 1).choices.map(choice => choice.action)).toEqual([
      { kind: 'locale', locale: 'zh-CN' },
      { kind: 'locale', locale: 'en-US' },
    ])
  })
})

describe('the whole menu model', () => {
  it('holds both groups and the window items, in the active locale', () => {
    const model = shellMenuModel(ZH)
    expect(model.openMainWindow).toBe('打开主窗口')
    expect(model.settings).toBe('设置')
    expect(model.quit).toBe('退出')
    expect(model.groups.map(group => group.label)).toEqual(['外观', '语言'])
    expect(model.strings.reloadChat).toBe('重新加载 Chat')
    expect(shellMenuModel(EN_DARK).strings.reloadChat).toBe('Reload Chat')
  })

  it('never translates a product name', () => {
    const labels = shellMenuModel(ZH).groups.flatMap(group => [group.label, ...group.choices.map(c => c.label)])
    for (const label of labels) {
      expect(/Chat|Harness|Work|工作台|工作模式/.test(label)).toBe(false)
    }
  })

  it('re-renders every label when only the locale changes', () => {
    const themeOnly = shellMenuModel({ theme: 'dark', locale: 'zh-CN' })
    const localeOnly = shellMenuModel({ theme: 'dark', locale: 'en-US' })
    expect(themeOnly.groups[0]!.choices.map(c => c.checked)).toEqual(localeOnly.groups[0]!.choices.map(c => c.checked))
    expect(themeOnly.groups[0]!.label).not.toBe(localeOnly.groups[0]!.label)
  })
})
