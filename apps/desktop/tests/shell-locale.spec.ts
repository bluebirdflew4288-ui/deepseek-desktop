/** Shell locale resolution and the closed string table. */

import { describe, expect, it } from 'vitest'
import {
  DESKTOP_SHELL_LOCALES,
  DESKTOP_SHELL_LOCALE_LABELS,
  isDesktopShellLocale,
  resolveShellLocale,
  shellStrings,
} from '../src/shell-locale.ts'

describe('resolveShellLocale', () => {
  it('outranks the operating system with an explicit persisted choice', () => {
    expect(resolveShellLocale('zh-CN', 'en-US')).toBe('en-US')
    expect(resolveShellLocale('en-US', 'zh-CN')).toBe('zh-CN')
  })

  it('ignores a persisted value outside the closed union', () => {
    expect(resolveShellLocale('zh-CN', 'fr-FR')).toBe('zh-CN')
    expect(resolveShellLocale('en-GB', '')).toBe('en-US')
  })

  it('selects zh-CN for every Chinese spelling Electron may report', () => {
    for (const tag of ['zh', 'zh-CN', 'zh-TW', 'zh-Hans', 'zh-Hans-CN', 'ZH-cn']) {
      expect([tag, resolveShellLocale(tag)]).toEqual([tag, 'zh-CN'])
    }
  })

  it('falls back to en-US for any other UI language', () => {
    for (const tag of ['en', 'en-GB', 'ja-JP', 'fr-FR', '']) {
      expect([tag, resolveShellLocale(tag)]).toEqual([tag, 'en-US'])
    }
  })
})

describe('the shell string table', () => {
  it('renders every string for every locale, with no empty value', () => {
    for (const locale of DESKTOP_SHELL_LOCALES) {
      const strings = shellStrings(locale)
      // Enumerated rather than reflected: the key list is asserted too, so a
      // string added to the table cannot ship untranslated by passing silently.
      expect(Object.keys(strings)).toEqual([
        'openMainWindow', 'settings',
        'memory', 'manageMemory', 'exportMemory', 'importMemory',
        'memoryReady', 'memoryUnavailable', 'appearance',
        'themeSystem', 'themeLight', 'themeDark',
        'language', 'quit', 'failedToStartTitle', 'failedToStartMessage',
        'aboutApp', 'hideApp', 'hideOthers', 'unhideApp', 'quitApp',
        'menuEdit', 'menuView', 'menuWindow',
        'undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle',
        'delete', 'selectAll',
        'substitutions', 'showSubstitutions', 'smartQuotes',
        'smartDashes', 'textReplacement',
        'speech', 'startSpeaking', 'stopSpeaking',
        'reload', 'forceReload', 'toggleDevTools',
        'actualSize', 'zoomIn', 'zoomOut', 'toggleFullScreen', 'closeWindow',
        'minimize', 'zoomWindow', 'bringAllToFront',
        'modeSwitchLabel', 'chatActionsLabel', 'harnessUnseenResults', 'reloadChat', 'clearChatData',
        'clearChatConfirmMessage', 'cancel', 'confirmClear',
        'loadingChat', 'loadingHarness', 'unavailableChat', 'unavailableHarness',
        'retry', 'openBrowser', 'openExternal',
        'harnessSetupTitle', 'harnessSetupMessage',
        'harnessBusyTitle', 'harnessBusyMessage', 'installHarness',
        'harness', 'harnessVersionPrefix', 'harnessInstall',
        'harnessCheckForUpdate', 'harnessUpdate', 'harnessRestart',
        'harnessAdvanced', 'harnessRollback', 'harnessReinstall', 'harnessOpenLog',
        'harnessStatusNotInstalled', 'harnessStatusReady', 'harnessStatusBusy',
        'harnessStatusFailed', 'harnessStatusInvalid',
        'harnessResultTitle', 'harnessUpToDate', 'harnessUpdateAvailablePrefix',
        'harnessUpdatePreparing', 'harnessUpdateInstalling', 'harnessUpdateVerifying', 'harnessUpdateHealth',
        'harnessUpdateCancelling', 'harnessUpdateKeepOpen', 'harnessUpdateCannotCancel',
        'harnessUpdateCancelQuestion', 'harnessUpdateKeepGoing',
        'harnessUpdateClose', 'harnessUpdateCollapse',
        'harnessUpdateCompleted', 'harnessInstallCompleted',
        'harnessReinstallCompleted', 'harnessUpdateRestartEffect',
        'harnessUpdateFailed', 'harnessInstallFailed',
        'harnessUpdateCancelled', 'harnessInstallCancelled',
      ])
      // Enumerated like the keys: reflection over the interface would type as
      // any[] and hide a non-string value from both the compiler and lint.
      const values: string[] = [
        strings.openMainWindow,
        strings.settings,
        strings.memory,
        strings.manageMemory,
        strings.exportMemory,
        strings.importMemory,
        strings.memoryReady,
        strings.memoryUnavailable,
        strings.appearance,
        strings.themeSystem,
        strings.themeLight,
        strings.themeDark,
        strings.language,
        strings.quit,
        strings.failedToStartTitle,
        strings.failedToStartMessage,
        strings.aboutApp,
        strings.hideApp,
        strings.hideOthers,
        strings.unhideApp,
        strings.quitApp,
        strings.menuEdit,
        strings.menuView,
        strings.menuWindow,
        strings.closeWindow,
        strings.undo,
        strings.redo,
        strings.cut,
        strings.copy,
        strings.paste,
        strings.pasteAndMatchStyle,
        strings.delete,
        strings.selectAll,
        strings.substitutions,
        strings.showSubstitutions,
        strings.smartQuotes,
        strings.smartDashes,
        strings.textReplacement,
        strings.speech,
        strings.startSpeaking,
        strings.stopSpeaking,
        strings.reload,
        strings.forceReload,
        strings.toggleDevTools,
        strings.actualSize,
        strings.zoomIn,
        strings.zoomOut,
        strings.toggleFullScreen,
        strings.minimize,
        strings.zoomWindow,
        strings.bringAllToFront,
        strings.modeSwitchLabel,
        strings.chatActionsLabel,
        strings.harnessUnseenResults,
        strings.reloadChat,
        strings.clearChatData,
        strings.clearChatConfirmMessage,
        strings.cancel,
        strings.confirmClear,
        strings.loadingChat,
        strings.loadingHarness,
        strings.unavailableChat,
        strings.unavailableHarness,
        strings.retry,
        strings.openBrowser,
        strings.openExternal,
        strings.harnessSetupTitle,
        strings.harnessSetupMessage,
        strings.harnessBusyTitle,
        strings.harnessBusyMessage,
        strings.installHarness,
        strings.harness,
        strings.harnessVersionPrefix,
        strings.harnessInstall,
        strings.harnessCheckForUpdate,
        strings.harnessUpdate,
        strings.harnessRestart,
        strings.harnessAdvanced,
        strings.harnessRollback,
        strings.harnessReinstall,
        strings.harnessOpenLog,
        strings.harnessStatusNotInstalled,
        strings.harnessStatusReady,
        strings.harnessStatusBusy,
        strings.harnessStatusFailed,
        strings.harnessStatusInvalid,
        strings.harnessResultTitle,
        strings.harnessUpToDate,
        strings.harnessUpdateAvailablePrefix,
        strings.harnessUpdatePreparing,
        strings.harnessUpdateInstalling,
        strings.harnessUpdateVerifying,
        strings.harnessUpdateHealth,
        strings.harnessUpdateCancelling,
        strings.harnessUpdateKeepOpen,
        strings.harnessUpdateCannotCancel,
        strings.harnessUpdateCancelQuestion,
        strings.harnessUpdateKeepGoing,
        strings.harnessUpdateClose,
        strings.harnessUpdateCollapse,
        strings.harnessUpdateCompleted,
        strings.harnessInstallCompleted,
        strings.harnessReinstallCompleted,
        strings.harnessUpdateRestartEffect,
        strings.harnessUpdateFailed,
        strings.harnessInstallFailed,
        strings.harnessUpdateCancelled,
        strings.harnessInstallCancelled,
      ]
      expect([locale, values.every(value => value.length > 0)]).toEqual([locale, true])
    }
  })

  it('keeps the two locales distinct where they must differ', () => {
    expect(shellStrings('zh-CN').quit).not.toBe(shellStrings('en-US').quit)
    expect(shellStrings('zh-CN').openMainWindow).toBe('打开主窗口')
    expect(shellStrings('en-US').openMainWindow).toBe('Open Main Window')
  })

  it('labels the standard menus in each locale, product names verbatim', () => {
    expect(shellStrings('zh-CN').aboutApp).toBe('关于 DeepSeek Desktop')
    expect(shellStrings('zh-CN').menuEdit).toBe('编辑')
    expect(shellStrings('zh-CN').reloadChat).toBe('重新加载 Chat')
    expect(shellStrings('zh-CN').clearChatData).toBe('清除 Chat 数据')
    expect(shellStrings('en-US').aboutApp).toBe('About DeepSeek Desktop')
    expect(shellStrings('en-US').reloadChat).toBe('Reload Chat')
  })

  it('labels each locale in that locale, for the picker', () => {
    expect(DESKTOP_SHELL_LOCALE_LABELS['zh-CN']).toBe('简体中文')
    expect(DESKTOP_SHELL_LOCALE_LABELS['en-US']).toBe('English')
  })

  it('accepts exactly the closed locale union', () => {
    expect(isDesktopShellLocale('zh-CN')).toBe(true)
    expect(isDesktopShellLocale('en-US')).toBe(true)
    expect(isDesktopShellLocale('fr-FR')).toBe(false)
    expect(isDesktopShellLocale(undefined)).toBe(false)
  })
})
