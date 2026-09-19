/** macOS effects for the desktop notification ledger. Other platforms remain unsupported. */
import { app, Notification } from 'electron'
import type { DesktopNotificationAdapter, DesktopTaskEvent } from './desktop-notifications.ts'
import type { DesktopShellLocale } from './shell-locale.ts'

/**
 * Create native notifications with fixed, content-free localized copy.
 * @param locale - Current desktop language, resolved when an alert is dispatched.
 * @param reportError - Native delivery failures; unread state remains intact.
 * @returns An adapter retaining notifications until close or application disposal.
 */
export function createNativeNotifications(
  locale: () => DesktopShellLocale,
  reportError: (error: unknown) => void,
): DesktopNotificationAdapter {
  const active = new Set<Notification>()
  return {
    supported: () => process.platform === 'darwin' && Notification.isSupported(),
    show(event: DesktopTaskEvent, onClick) {
      const zh = locale() === 'zh-CN'
      const body = event.source === 'chat' ? (zh ? 'Chat 回复已完成' : 'Chat reply completed')
        : event.kind === 'completed' ? (zh ? 'Harness 任务已完成' : 'Harness task completed')
          : event.kind === 'failed' ? (zh ? 'Harness 任务执行失败' : 'Harness task failed')
            : (zh ? 'Harness 正在等待你的操作' : 'Harness needs your attention')
      const notification = new Notification({ title: 'DeepSeek Desktop', body })
      active.add(notification)
      notification.once('click', onClick)
      notification.once('close', () => { active.delete(notification) })
      notification.once('failed', () => {
        active.delete(notification)
        reportError(new Error('Native notification delivery failed; check macOS notification settings'))
      })
      notification.show()
    },
    // The numeric Dock badge is macOS-owned presentation: `setBadgeCount` draws
    // the number on the Dock icon and zero removes it, so the ledger never paints
    // its own overlay or rewrites the application icon.
    setDockBadge(count) { if (process.platform === 'darwin') app.setBadgeCount(count) },
    dispose() {
      for (const notification of active) { notification.removeAllListeners(); notification.close() }
      active.clear()
    },
  }
}
