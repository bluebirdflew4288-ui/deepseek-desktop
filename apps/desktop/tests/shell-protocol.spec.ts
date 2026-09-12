import { describe, expect, it } from 'vitest'
import {
  DESKTOP_SHELL_CHANNELS,
  type DesktopChromeLayout,
  isDesktopChromeSurface,
  isDesktopShellCommand,
  localePayloadLocale,
  localePayloadString,
} from '../src/shell-protocol.ts'
import { shellStrings } from '../src/shell-locale.ts'

describe('desktop shell protocol', () => {
  it('keeps the closed channel names stable', () => {
    expect(DESKTOP_SHELL_CHANNELS.select).toBe('dsh-desktop:select-mode')
    expect(DESKTOP_SHELL_CHANNELS.command).toBe('dsh-desktop:shell-command')
    expect(DESKTOP_SHELL_CHANNELS.snapshot).toBe('dsh-desktop:mode-snapshot')
    expect(DESKTOP_SHELL_CHANNELS.chromeSurface).toBe('dsh-desktop:chrome-surface')
    expect(DESKTOP_SHELL_CHANNELS.chromeLayout).toBe('dsh-desktop:chrome-layout')
    expect(DESKTOP_SHELL_CHANNELS.chromeTheme).toBe('dsh-desktop:chrome-theme')
    expect(DESKTOP_SHELL_CHANNELS.titlebarBackground).toBe('dsh-desktop:titlebar-background')
    expect(DESKTOP_SHELL_CHANNELS.shellStrings).toBe('dsh-desktop:shell-strings')
  })

  it('accepts only the closed command union', () => {
    expect(DESKTOP_SHELL_CHANNELS.command).toBe('dsh-desktop:shell-command')
    for (const value of ['retry-chat', 'retry-harness', 'reload-chat', 'clear-chat-data', 'open-chat-browser', 'open-pending-external', 'close-window']) {
      expect(isDesktopShellCommand(value)).toBe(true)
    }
    expect(isDesktopShellCommand('open-arbitrary-url')).toBe(false)
  })

  it('accepts only the closed chrome surface union', () => {
    for (const value of ['closed', 'chat-menu', 'dialog']) {
      expect(isDesktopChromeSurface(value)).toBe(true)
    }
    expect(isDesktopChromeSurface('mode-menu')).toBe(false)
    expect(isDesktopChromeSurface('full-window')).toBe(false)
  })

  it('reports the applied chrome surface in layout acknowledgements', () => {
    const layout = {
      surface: 'chat-menu',
      dismissMenus: false,
    } satisfies DesktopChromeLayout
    expect(layout).toEqual({ surface: 'chat-menu', dismissMenus: false })
  })
})

describe('the shell-strings payload guards', () => {
  const payload = { locale: 'zh-CN', strings: shellStrings('zh-CN') }

  it('reads the locale and one labelled string out of a well-formed payload', () => {
    expect(localePayloadLocale(payload)).toBe('zh-CN')
    expect(localePayloadString(payload, 'reloadChat')).toBe('重新加载 Chat')
  })

  it('rejects a malformed locale instead of adopting it', () => {
    for (const bad of [undefined, null, 42, 'zh-CN', {}, { locale: 'fr-FR' }]) {
      expect(localePayloadLocale(bad)).toBeUndefined()
    }
  })

  it('rejects a malformed string table instead of blanking labels', () => {
    for (const bad of [undefined, null, 42, {}, { strings: 'no' }, { strings: { reloadChat: '' } }]) {
      expect(localePayloadString(bad, 'reloadChat')).toBeUndefined()
    }
    expect(localePayloadString({ ...payload, locale: 'en-US' }, 'reloadChat')).toBe('重新加载 Chat')
  })
})
