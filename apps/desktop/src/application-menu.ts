/** Platform-native application menu assembled from the shared desktop actions. */
import type { MenuItemConstructorOptions } from 'electron'
import type { ShellMenuModel } from './shell-menu.ts'

/** Product commands and current state supplied by the main process. */
export interface ApplicationMenuActions {
  readonly memory: (action: 'manage' | 'export' | 'import') => void
  readonly memoryReady: boolean
  readonly harness: MenuItemConstructorOptions[]
  readonly settings: MenuItemConstructorOptions[]
}

/**
 * Build the localized application menu for the host platform.
 * @param model - Current labels and preferences.
 * @param actions - Product operations shared with the tray.
 * @param platform - Host operating system.
 * @returns Native menu descriptors.
 */
export function applicationMenuTemplate(
  model: ShellMenuModel,
  actions: ApplicationMenuActions,
  platform: NodeJS.Platform,
): MenuItemConstructorOptions[] {
  const strings = model.strings
  return [
    {
      label: 'DeepSeek Desktop',
      submenu: [
        { role: 'about', label: strings.aboutApp },
        { type: 'separator' },
        {
          label: strings.memory,
          submenu: [
            { label: strings.manageMemory, click: () => { actions.memory('manage') } },
            { label: strings.exportMemory, click: () => { actions.memory('export') } },
            { label: strings.importMemory, click: () => { actions.memory('import') } },
            { type: 'separator' },
            {
              label: actions.memoryReady
                ? strings.memoryReady
                : strings.memoryUnavailable,
              enabled: false,
            },
          ],
        },
        { type: 'separator' },
        { label: strings.harness, submenu: actions.harness },
        { type: 'separator' },
        { label: model.settings, submenu: actions.settings },
        { type: 'separator' },
        ...(platform === 'darwin' ? [
          { role: 'hide', label: strings.hideApp },
          { role: 'hideOthers', label: strings.hideOthers },
          { role: 'unhide', label: strings.unhideApp },
          { type: 'separator' },
        ] satisfies MenuItemConstructorOptions[] : []),
        { role: 'quit', label: strings.quitApp },
      ],
    },
    {
      label: strings.menuEdit,
      submenu: [
        { role: 'undo', label: strings.undo },
        { role: 'redo', label: strings.redo },
        { type: 'separator' },
        { role: 'cut', label: strings.cut },
        { role: 'copy', label: strings.copy },
        { role: 'paste', label: strings.paste },
        { role: 'pasteAndMatchStyle', label: strings.pasteAndMatchStyle },
        { role: 'delete', label: strings.delete },
        { role: 'selectAll', label: strings.selectAll },
        ...(platform === 'darwin' ? [
          { type: 'separator' },
          {
            label: strings.substitutions,
            submenu: [
              { role: 'showSubstitutions', label: strings.showSubstitutions },
              { type: 'separator' },
              { role: 'toggleSmartQuotes', label: strings.smartQuotes },
              { role: 'toggleSmartDashes', label: strings.smartDashes },
              { role: 'toggleTextReplacement', label: strings.textReplacement },
            ],
          },
          {
            label: strings.speech,
            submenu: [
              { role: 'startSpeaking', label: strings.startSpeaking },
              { role: 'stopSpeaking', label: strings.stopSpeaking },
            ],
          },
        ] satisfies MenuItemConstructorOptions[] : []),
      ],
    },
    {
      label: strings.menuView,
      submenu: [
        { role: 'reload', label: strings.reload },
        { role: 'forceReload', label: strings.forceReload },
        { role: 'toggleDevTools', label: strings.toggleDevTools },
        { type: 'separator' },
        { role: 'resetZoom', label: strings.actualSize },
        { role: 'zoomIn', label: strings.zoomIn },
        { role: 'zoomOut', label: strings.zoomOut },
        { type: 'separator' },
        { role: 'togglefullscreen', label: strings.toggleFullScreen },
      ],
    },
    // The Window menu keeps its role: it is what registers the menu with the
    // operating system, which then inserts its tiling and window-list items
    // beside ours. localizeWindowMenu rewrites the labels the role owns.
    platform === 'darwin' ? { role: 'windowMenu' } : {
      label: strings.menuWindow,
      submenu: [
        { role: 'minimize', label: strings.minimize },
        { role: 'close', label: strings.closeWindow, accelerator: 'Alt+F4' },
      ],
    },
  ]
}
