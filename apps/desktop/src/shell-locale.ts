/**
 * Language of the desktop-owned shell surfaces: the application menu, the tray
 * menu, the title-bar mode chrome, the shell status surface, and the startup
 * failure dialog. The Harness and Chat surfaces keep their own localization and
 * are deliberately not touched — this module owns only the strings the shell
 * itself renders, which previously mixed a Chinese tray against an English
 * dialog with no way to choose.
 *
 * Menu items the operating system inserts into the standard menus (dictation,
 * emoji, window tiling) are not strings of this table: they follow the bundle's
 * own localizations, which the packaged shell supplies as zh_CN.lproj.
 *
 * Product names (DeepSeek, Chat, Harness) never enter this table translated:
 * labels may carry them verbatim, such as the Chat actions of the mode chrome.
 */

import type { DesktopThemePreference } from './desktop-theme.ts'

/** Locales the shell can render. */
export const DESKTOP_SHELL_LOCALES = ['zh-CN', 'en-US'] as const

/** One shell locale. */
export type DesktopShellLocale = typeof DESKTOP_SHELL_LOCALES[number]

/** Every string the desktop shell renders itself. */
export interface DesktopShellStrings {
  /** Tray item restoring the main window. */
  readonly openMainWindow: string
  /** Heading of the desktop-owned settings group. */
  readonly settings: string
  /** Heading for the local Memory tools. */
  readonly memory: string
  /** Open the local Memory manager. */
  readonly manageMemory: string
  /** Export local Memory through a native save dialog. */
  readonly exportMemory: string
  /** Import local Memory through a native open dialog. */
  readonly importMemory: string
  /** Disabled status item shown while Memory is available. */
  readonly memoryReady: string
  /** Disabled status item shown when Memory failed independently. */
  readonly memoryUnavailable: string
  /** Settings group choosing the resolved color scheme. */
  readonly appearance: string
  /** Appearance choice following the operating system. */
  readonly themeSystem: string
  /** Appearance choice pinned to the light palette. */
  readonly themeLight: string
  /** Appearance choice pinned to the dark palette. */
  readonly themeDark: string
  /** Submenu heading for the shell language. */
  readonly language: string
  /** Tray item quitting the application (closing a window only hides it). */
  readonly quit: string
  /** Startup failure dialog title, with the product name interpolated. */
  readonly failedToStartTitle: string
  /** Startup failure dialog body preceding the underlying error. */
  readonly failedToStartMessage: string
  /** Product menu item opening the system about panel. */
  readonly aboutApp: string
  /** Product menu item hiding the application window. */
  readonly hideApp: string
  /** Product menu item hiding every other application. */
  readonly hideOthers: string
  /** Product menu item restoring every hidden application. */
  readonly unhideApp: string
  /** Product menu item quitting the application. */
  readonly quitApp: string
  /** Menu bar title of the standard edit menu. */
  readonly menuEdit: string
  /** Menu bar title of the standard view menu. */
  readonly menuView: string
  /** Menu bar title of the standard window menu. */
  readonly menuWindow: string
  /** Edit menu item undoing the last change. */
  readonly undo: string
  /** Edit menu item redoing the undone change. */
  readonly redo: string
  /** Edit menu item cutting the selection. */
  readonly cut: string
  /** Edit menu item copying the selection. */
  readonly copy: string
  /** Edit menu item pasting the clipboard. */
  readonly paste: string
  /** Edit menu item pasting without foreign styling. */
  readonly pasteAndMatchStyle: string
  /** Edit menu item deleting the selection. */
  readonly delete: string
  /** Edit menu item selecting everything. */
  readonly selectAll: string
  /** Heading of the substitutions submenu. */
  readonly substitutions: string
  /** Substitutions item opening the substitutions panel. */
  readonly showSubstitutions: string
  /** Substitutions item toggling smart quotes. */
  readonly smartQuotes: string
  /** Substitutions item toggling smart dashes. */
  readonly smartDashes: string
  /** Substitutions item toggling text replacement. */
  readonly textReplacement: string
  /** Heading of the speech submenu. */
  readonly speech: string
  /** Speech item starting spoken feedback. */
  readonly startSpeaking: string
  /** Speech item stopping spoken feedback. */
  readonly stopSpeaking: string
  /** View menu item reloading the active surface. */
  readonly reload: string
  /** View menu item reloading without caches. */
  readonly forceReload: string
  /** View menu item toggling the developer tools. */
  readonly toggleDevTools: string
  /** View menu item restoring the default zoom. */
  readonly actualSize: string
  /** View menu item zooming in. */
  readonly zoomIn: string
  /** View menu item zooming out. */
  readonly zoomOut: string
  /** View menu item toggling full screen. */
  readonly toggleFullScreen: string
  /** Window menu item minimizing the window. */
  readonly minimize: string
  /** Window menu item closing the window without quitting the application. */
  readonly closeWindow: string
  /** Window menu item zooming the window. */
  readonly zoomWindow: string
  /** Window menu item bringing every window forward. */
  readonly bringAllToFront: string
  /** Accessible name of the mode switch in the title bar chrome. */
  readonly modeSwitchLabel: string
  /** Accessible name of the Chat actions button and its menu. */
  readonly chatActionsLabel: string
  /** Accessible suffix naming an unseen Harness result on the Harness entry. */
  readonly harnessUnseenResults: string
  /** Chrome menu item reloading the embedded Chat. */
  readonly reloadChat: string
  /** Chrome menu item clearing the Chat partition. */
  readonly clearChatData: string
  /** Confirmation dialog body of the Chat partition clear. */
  readonly clearChatConfirmMessage: string
  /** Confirmation dialog button keeping the Chat partition. */
  readonly cancel: string
  /** Confirmation dialog button clearing the Chat partition. */
  readonly confirmClear: string
  /** Shell status title while Chat loads. */
  readonly loadingChat: string
  /** Shell status title while Harness loads. */
  readonly loadingHarness: string
  /** Shell status title when Chat failed. */
  readonly unavailableChat: string
  /** Shell status title when Harness failed. */
  readonly unavailableHarness: string
  /** Shell status button retrying the failed surface. */
  readonly retry: string
  /** Shell status button opening Chat in the external browser. */
  readonly openBrowser: string
  /** Shell status button opening a pending external link. */
  readonly openExternal: string
  /** Shell status title while no Harness version is installed. */
  readonly harnessSetupTitle: string
  /** Shell status body while no Harness version is installed. */
  readonly harnessSetupMessage: string
  /** Shell status title while a Harness install or update runs. */
  readonly harnessBusyTitle: string
  /** Shell status body while a Harness install or update runs. */
  readonly harnessBusyMessage: string
  /** Shell status button installing the official Harness. */
  readonly installHarness: string
  /** Heading of the Harness menu. */
  readonly harness: string
  /** Prefix the menu joins with the installed Harness version. */
  readonly harnessVersionPrefix: string
  /** Menu item installing the official Harness. */
  readonly harnessInstall: string
  /** Menu item reading the official registry for a newer Harness. */
  readonly harnessCheckForUpdate: string
  /** Menu item installing and promoting the newest official Harness. */
  readonly harnessUpdate: string
  /** Menu item stopping and starting the Harness this desktop owns. */
  readonly harnessRestart: string
  /** Heading of the Harness menu's advanced group. */
  readonly harnessAdvanced: string
  /** Menu item promoting the retained previous Harness version. */
  readonly harnessRollback: string
  /** Menu item replacing the installed Harness with a fresh copy. */
  readonly harnessReinstall: string
  /** Menu item revealing the managed Harness diagnostic log. */
  readonly harnessOpenLog: string
  /** Harness status line when no version is installed. */
  readonly harnessStatusNotInstalled: string
  /** Harness status line when a version is promoted and launchable. */
  readonly harnessStatusReady: string
  /** Harness status line while a transaction runs. */
  readonly harnessStatusBusy: string
  /** Harness status line after a transaction failed. */
  readonly harnessStatusFailed: string
  /** Harness status line when the version state cannot be read. */
  readonly harnessStatusInvalid: string
  /** Dialog title for Harness update and transaction results. */
  readonly harnessResultTitle: string
  /** Dialog body reporting that no newer official Harness exists. */
  readonly harnessUpToDate: string
  /** Dialog prefix the desktop joins with the newest official version. */
  readonly harnessUpdateAvailablePrefix: string
  /** Update card line while the transaction reads the registry and stages. */
  readonly harnessUpdatePreparing: string
  /** Update card line while the package manager fetches and writes the release. */
  readonly harnessUpdateInstalling: string
  /** Update card line while the staged tree is checked against the resolved release. */
  readonly harnessUpdateVerifying: string
  /** Update card line while the staged release is launched to prove it runs. */
  readonly harnessUpdateHealth: string
  /** Update card line once the runtime has accepted a cancel request. */
  readonly harnessUpdateCancelling: string
  /** Update card footer asking the user to keep the application open. */
  readonly harnessUpdateKeepOpen: string
  /** Update card answer when cancelling would interrupt an uninterruptible step. */
  readonly harnessUpdateCannotCancel: string
  /** Update card question asking whether to stop a cancellable transaction. */
  readonly harnessUpdateCancelQuestion: string
  /** Update card button closing the cancel question and resuming the wait. */
  readonly harnessUpdateKeepGoing: string
  /** Accessible name of the update card control that takes the card away. */
  readonly harnessUpdateClose: string
  /** Accessible name of the update card control that hides the card but runs on. */
  readonly harnessUpdateCollapse: string
  /** Update card title once an update promoted a version the live Harness is not yet serving. */
  readonly harnessUpdateCompleted: string
  /** Update card title once a first install promoted a version. */
  readonly harnessInstallCompleted: string
  /** Update card title once the version already in use was promoted again. */
  readonly harnessReinstallCompleted: string
  /** Update card line naming what makes a promoted version take effect. */
  readonly harnessUpdateRestartEffect: string
  /** Update card title after an update or reinstall failed. */
  readonly harnessUpdateFailed: string
  /** Update card title after a first install failed. */
  readonly harnessInstallFailed: string
  /** Update card title after the user cancelled an update or reinstall. */
  readonly harnessUpdateCancelled: string
  /** Update card title after the user cancelled a first install. */
  readonly harnessInstallCancelled: string
}

const STRINGS: Readonly<Record<DesktopShellLocale, DesktopShellStrings>> = {
  'zh-CN': {
    openMainWindow: '打开主窗口',
    settings: '设置',
    memory: 'Memory',
    manageMemory: '管理 Memory…',
    exportMemory: '导出 Memory JSON…',
    importMemory: '导入 Memory JSON…',
    memoryReady: '状态：可用',
    memoryUnavailable: '状态：不可用',
    appearance: '外观',
    themeSystem: '跟随系统',
    themeLight: '浅色',
    themeDark: '深色',
    language: '语言',
    quit: '退出',
    failedToStartTitle: '启动失败',
    failedToStartMessage: '桌面应用未能启动。',
    aboutApp: '关于 DeepSeek Desktop',
    hideApp: '隐藏 DeepSeek Desktop',
    hideOthers: '隐藏其他',
    unhideApp: '显示全部',
    quitApp: '退出 DeepSeek Desktop',
    menuEdit: '编辑',
    menuView: '显示',
    menuWindow: '窗口',
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '拷贝',
    paste: '粘贴',
    pasteAndMatchStyle: '粘贴并匹配样式',
    delete: '删除',
    selectAll: '全选',
    substitutions: '替换',
    showSubstitutions: '显示替换',
    smartQuotes: '智能引号',
    smartDashes: '智能破折号',
    textReplacement: '文本替换',
    speech: '语音',
    startSpeaking: '开始说话',
    stopSpeaking: '停止说话',
    reload: '重新加载',
    forceReload: '强制重新加载',
    toggleDevTools: '切换开发者工具',
    actualSize: '实际大小',
    zoomIn: '放大',
    zoomOut: '缩小',
    toggleFullScreen: '切换全屏',
    closeWindow: '关闭窗口',
    minimize: '最小化',
    zoomWindow: '缩放',
    bringAllToFront: '前置全部窗口',
    modeSwitchLabel: '桌面模式',
    chatActionsLabel: 'Chat 操作',
    harnessUnseenResults: '有新结果',
    reloadChat: '重新加载 Chat',
    clearChatData: '清除 Chat 数据',
    clearChatConfirmMessage: '清除此 DeepSeek Chat 数据将同时删除登录状态和本地 Memory。如需保留 Memory，请先导出 JSON。',
    cancel: '取消',
    confirmClear: '清除数据',
    loadingChat: '正在加载 Chat',
    loadingHarness: '正在加载 Harness',
    unavailableChat: 'Chat 不可用',
    unavailableHarness: 'Harness 不可用',
    retry: '重试',
    openBrowser: '在浏览器中打开',
    openExternal: '在浏览器中打开链接',
    harnessSetupTitle: 'DeepSeek Harness 尚未安装',
    harnessSetupMessage: '安装后即可在 Harness 标签页使用官方 Harness。',
    harnessBusyTitle: '正在处理 DeepSeek Harness…',
    harnessBusyMessage: '正在下载并校验官方 Harness，请保持应用开启。',
    installHarness: '安装 Harness',
    harness: 'Harness',
    harnessVersionPrefix: '版本：',
    harnessInstall: '安装 Harness…',
    harnessCheckForUpdate: '检查更新…',
    harnessUpdate: '更新 Harness…',
    harnessRestart: '重启 Harness',
    harnessAdvanced: '高级',
    harnessRollback: '回滚到上一版本…',
    harnessReinstall: '重新安装 Harness…',
    harnessOpenLog: '打开诊断日志',
    harnessStatusNotInstalled: '状态：未安装',
    harnessStatusReady: '状态：可用',
    harnessStatusBusy: '状态：处理中…',
    harnessStatusFailed: '状态：失败',
    harnessStatusInvalid: '状态：版本记录不可用',
    harnessResultTitle: 'Harness',
    harnessUpToDate: 'Harness 已是最新版本。',
    harnessUpdateAvailablePrefix: '发现新版本：',
    harnessUpdatePreparing: '正在准备…',
    harnessUpdateInstalling: '正在下载并安装 Harness…',
    harnessUpdateVerifying: '正在校验安装…',
    harnessUpdateHealth: '正在验证运行情况…',
    harnessUpdateCancelling: '正在取消…',
    harnessUpdateKeepOpen: '更新期间请勿关闭应用。',
    harnessUpdateCannotCancel: '当前步骤无法中断，暂时无法取消。',
    harnessUpdateCancelQuestion: '要取消 Harness 更新吗？',
    harnessUpdateKeepGoing: '继续更新',
    harnessUpdateClose: '关闭',
    harnessUpdateCollapse: '收起',
    harnessUpdateCompleted: 'Harness 更新已安装',
    harnessInstallCompleted: 'Harness 安装完成',
    harnessReinstallCompleted: 'Harness 重新安装完成',
    harnessUpdateRestartEffect: '重启 Harness 后生效',
    harnessUpdateFailed: 'Harness 更新失败',
    harnessInstallFailed: 'Harness 安装失败',
    harnessUpdateCancelled: 'Harness 更新已取消',
    harnessInstallCancelled: 'Harness 安装已取消',
  },
  'en-US': {
    openMainWindow: 'Open Main Window',
    settings: 'Settings',
    memory: 'Memory',
    manageMemory: 'Manage Memory…',
    exportMemory: 'Export Memory JSON…',
    importMemory: 'Import Memory JSON…',
    memoryReady: 'Status: Available',
    memoryUnavailable: 'Status: Unavailable',
    appearance: 'Appearance',
    themeSystem: 'Follow System',
    themeLight: 'Light',
    themeDark: 'Dark',
    language: 'Language',
    quit: 'Quit',
    failedToStartTitle: 'Failed to Start',
    failedToStartMessage: 'The desktop application could not start.',
    aboutApp: 'About DeepSeek Desktop',
    hideApp: 'Hide DeepSeek Desktop',
    hideOthers: 'Hide Others',
    unhideApp: 'Show All',
    quitApp: 'Quit DeepSeek Desktop',
    menuEdit: 'Edit',
    menuView: 'View',
    menuWindow: 'Window',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    pasteAndMatchStyle: 'Paste and Match Style',
    delete: 'Delete',
    selectAll: 'Select All',
    substitutions: 'Substitutions',
    showSubstitutions: 'Show Substitutions',
    smartQuotes: 'Smart Quotes',
    smartDashes: 'Smart Dashes',
    textReplacement: 'Text Replacement',
    speech: 'Speech',
    startSpeaking: 'Start Speaking',
    stopSpeaking: 'Stop Speaking',
    reload: 'Reload',
    forceReload: 'Force Reload',
    toggleDevTools: 'Toggle Developer Tools',
    actualSize: 'Actual Size',
    zoomIn: 'Zoom In',
    zoomOut: 'Zoom Out',
    toggleFullScreen: 'Toggle Full Screen',
    closeWindow: 'Close Window',
    minimize: 'Minimize',
    zoomWindow: 'Zoom',
    bringAllToFront: 'Bring All to Front',
    modeSwitchLabel: 'Desktop mode',
    chatActionsLabel: 'Chat actions',
    harnessUnseenResults: 'New results',
    reloadChat: 'Reload Chat',
    clearChatData: 'Clear Chat Data',
    clearChatConfirmMessage: 'Clearing this DeepSeek Chat data also deletes the login state and local Memory. Export JSON first if you want to keep Memory.',
    cancel: 'Cancel',
    confirmClear: 'Clear data',
    loadingChat: 'Loading Chat',
    loadingHarness: 'Loading Harness',
    unavailableChat: 'Chat unavailable',
    unavailableHarness: 'Harness unavailable',
    retry: 'Retry',
    openBrowser: 'Open in browser',
    openExternal: 'Open link in browser',
    harnessSetupTitle: 'DeepSeek Harness is not installed',
    harnessSetupMessage: 'Install it to use the official Harness in the Harness tab.',
    harnessBusyTitle: 'Working on DeepSeek Harness…',
    harnessBusyMessage: 'Downloading and verifying the official Harness. Keep the app open.',
    installHarness: 'Install Harness',
    harness: 'Harness',
    harnessVersionPrefix: 'Version: ',
    harnessInstall: 'Install Harness…',
    harnessCheckForUpdate: 'Check for Update…',
    harnessUpdate: 'Update Harness…',
    harnessRestart: 'Restart Harness',
    harnessAdvanced: 'Advanced',
    harnessRollback: 'Roll Back to Previous Version…',
    harnessReinstall: 'Reinstall Harness…',
    harnessOpenLog: 'Open Diagnostics',
    harnessStatusNotInstalled: 'Status: Not installed',
    harnessStatusReady: 'Status: Available',
    harnessStatusBusy: 'Status: Working…',
    harnessStatusFailed: 'Status: Failed',
    harnessStatusInvalid: 'Status: Version state unusable',
    harnessResultTitle: 'Harness',
    harnessUpToDate: 'Harness is up to date.',
    harnessUpdateAvailablePrefix: 'New version available: ',
    harnessUpdatePreparing: 'Preparing…',
    harnessUpdateInstalling: 'Downloading and installing Harness…',
    harnessUpdateVerifying: 'Verifying the installation…',
    harnessUpdateHealth: 'Checking that it runs…',
    harnessUpdateCancelling: 'Cancelling…',
    harnessUpdateKeepOpen: 'Keep the app open while the update runs.',
    harnessUpdateCannotCancel: 'This step cannot be interrupted, so the update cannot be cancelled yet.',
    harnessUpdateCancelQuestion: 'Cancel the Harness update?',
    harnessUpdateKeepGoing: 'Keep updating',
    harnessUpdateClose: 'Close',
    harnessUpdateCollapse: 'Minimize',
    harnessUpdateCompleted: 'Harness update installed',
    harnessInstallCompleted: 'Harness installation complete',
    harnessReinstallCompleted: 'Harness reinstalled',
    harnessUpdateRestartEffect: 'Takes effect after restarting Harness.',
    harnessUpdateFailed: 'Harness update failed',
    harnessInstallFailed: 'Harness installation failed',
    harnessUpdateCancelled: 'Harness update cancelled',
    harnessInstallCancelled: 'Harness installation cancelled',
  },
}

/** String-table key of each appearance choice, so the menu cannot drift from the union. */
export const DESKTOP_THEME_LABEL_KEYS = {
  system: 'themeSystem',
  light: 'themeLight',
  dark: 'themeDark',
} as const satisfies Record<DesktopThemePreference, keyof DesktopShellStrings>

/** Human-readable label of each locale, written in that locale. */
export const DESKTOP_SHELL_LOCALE_LABELS: Readonly<Record<DesktopShellLocale, string>> = {
  'zh-CN': '简体中文',
  'en-US': 'English',
}

/**
 * Test whether a persisted or reported value is a shell locale.
 * @param value - value read from storage or from Electron's UI language.
 * @returns whether it belongs to the closed locale union.
 */
export function isDesktopShellLocale(value: unknown): value is DesktopShellLocale {
  return DESKTOP_SHELL_LOCALES.some(locale => locale === value)
}

/**
 * Resolve the shell locale from an explicit choice or the operating system's UI
 * language. Electron reports BCP-47 tags of varying precision (`zh`, `zh-CN`,
 * `zh-Hans-CN`, `en-GB`), so a Chinese tag of any spelling selects `zh-CN` and
 * everything else falls back to `en-US` rather than to an unmatched exact tag.
 * @param appLocale - Electron's `app.getLocale()` value.
 * @param persisted - explicit user choice, which outranks the operating system.
 * @returns the locale the shell renders in.
 */
export function resolveShellLocale(appLocale: string, persisted?: string): DesktopShellLocale {
  if (persisted !== undefined && isDesktopShellLocale(persisted)) return persisted
  return appLocale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
}

/**
 * Read the strings for one locale.
 * @param locale - resolved shell locale.
 * @returns the closed string table for that locale.
 */
export function shellStrings(locale: DesktopShellLocale): DesktopShellStrings {
  return STRINGS[locale]
}
