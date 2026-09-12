/** Native Window-menu wiring shared by production and Electron lifecycle fixtures. */

import { MenuItem, type Menu } from 'electron'
import { type DesktopShellStrings } from './shell-locale.ts'

type WindowMenuStrings = Pick<
  DesktopShellStrings,
  'bringAllToFront' | 'closeWindow' | 'menuWindow' | 'minimize' | 'zoomWindow'
>

/**
 * Preserve Electron's native Window menu while adding the standard macOS close
 * command that dispatches BrowserWindow.close(). The application's close event
 * remains the single owner of hide-versus-quit behavior.
 * @param menu - Newly built application menu.
 * @param strings - Labels resolved from the current shell locale.
 * @param platform - Runtime platform used to keep the added accelerator macOS-only.
 */
export function configureNativeWindowMenu(
  menu: Menu,
  strings: WindowMenuStrings,
  platform: NodeJS.Platform,
): void {
  const windowMenu = menu.items.find(item =>
    item.submenu?.items.some(entry => entry.role === 'minimize') === true)
  if (windowMenu === undefined) return
  windowMenu.label = strings.menuWindow
  const submenu = windowMenu.submenu
  if (submenu === undefined) return

  if (platform === 'darwin' && !submenu.items.some(entry => entry.role === 'close')) {
    submenu.insert(0, new MenuItem({
      role: 'close',
      label: strings.closeWindow,
      accelerator: 'Command+W',
      click: (_menuItem, browserWindow) => { browserWindow?.close() },
    }))
    submenu.insert(1, new MenuItem({ type: 'separator' }))
  }

  for (const entry of submenu.items) {
    if (entry.role === 'minimize') entry.label = strings.minimize
    else if (entry.role === 'zoom') entry.label = strings.zoomWindow
    else if (entry.role === 'front') entry.label = strings.bringAllToFront
  }
}
