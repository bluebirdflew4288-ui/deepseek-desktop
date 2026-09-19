/**
 * The desktop-owned settings model rendered by both the application menu and the
 * tray menu. Both are views of one preference authority and hold no state of
 * their own, so the two menus cannot disagree and neither can drift from the
 * persisted preference.
 *
 * The groups hold appearance, language, and notification presentation because the
 * Harness and Chat surfaces own their own settings and are not mirrored here.
 * A future desktop-owned setting joins this model rather than growing a second
 * menu tree.
 */

import { DEFAULT_NOTIFICATION_PREFERENCES, type NotificationPreferences } from './desktop-notifications.ts'
import { type DesktopThemePreference } from './desktop-theme.ts'
import {
  DESKTOP_SHELL_LOCALES,
  DESKTOP_SHELL_LOCALE_LABELS,
  DESKTOP_THEME_LABEL_KEYS,
  shellStrings,
  type DesktopShellLocale,
  type DesktopShellStrings,
} from './shell-locale.ts'

/**
 * Appearance choices in the order the settings surface presents them: following
 * the operating system first, then the two pinned palettes.
 */
const THEME_PRESENTATION_ORDER = ['system', 'light', 'dark'] as const satisfies readonly DesktopThemePreference[]

/** What one settings choice does when the user picks it. */
export type ShellSettingsAction =
  | { readonly kind: 'custom-notification-accent' }
  | { readonly kind: 'notifications'; readonly preferences: NotificationPreferences }
  | { readonly kind: 'theme'; readonly preference: DesktopThemePreference }
  | { readonly kind: 'locale'; readonly locale: DesktopShellLocale }

/** One radio choice inside a settings group. */
export interface ShellSettingsChoice {
  /** Label already rendered in the active shell locale. */
  readonly label: string
  /** Whether this choice is the current preference. */
  readonly checked: boolean
  /** Effect of choosing it. */
  readonly action: ShellSettingsAction
}

/** One labelled group of radio choices or independent checkboxes. */
export interface ShellSettingsGroup {
  readonly type?: 'checkbox' | 'radio'
  /** Group heading, rendered in the active shell locale. */
  readonly label: string
  /** Choices use the group type; radio groups mark the selected preference. */
  readonly choices: readonly ShellSettingsChoice[]
}

/** The desktop-owned preferences both shell menus render. */
export interface DesktopShellPreferences {
  readonly notifications?: NotificationPreferences
  /** Appearance preference: follow the system, or pin a palette. */
  readonly theme: DesktopThemePreference
  /** Language of the desktop-owned surfaces. */
  readonly locale: DesktopShellLocale
}

/** Everything one shell menu renders, in presentation order. */
export interface ShellMenuModel {
  /** Label of the item restoring the main window. */
  readonly openMainWindow: string
  /** Heading of the settings group. */
  readonly settings: string
  /** Appearance and language groups. */
  readonly groups: readonly ShellSettingsGroup[]
  /** Label of the item quitting the application. */
  readonly quit: string
  /** The whole string table, for the menu labels outside the settings groups. */
  readonly strings: DesktopShellStrings
}

/**
 * Build the settings groups for one preference value.
 * @param preferences - current value of the single desktop preference authority.
 * @returns the appearance and language groups, each marking the active choice.
 */
export function shellSettingsGroups(preferences: DesktopShellPreferences): ShellSettingsGroup[] {
  const strings = shellStrings(preferences.locale)
  const p = preferences.notifications ?? DEFAULT_NOTIFICATION_PREFERENCES
  const zh = preferences.locale === 'zh-CN'
  const switches = [
    ['chat', zh ? 'Chat 回复' : 'Chat replies'],
    ['completed', zh ? 'Harness 完成' : 'Harness completed'],
    ['failed', zh ? 'Harness 失败' : 'Harness failed'],
    ['actionRequired', zh ? 'Harness 等待操作' : 'Harness action required'],
    ['dock', zh ? '显示 Dock 未读数量' : 'Show Dock unread count'],
    ['indicators', zh ? '显示站内未读提示' : 'Show in-app unread indicators'],
  ] as const
  return [
    {
      label: strings.appearance,
      choices: THEME_PRESENTATION_ORDER.map((preference): ShellSettingsChoice => ({
        label: strings[DESKTOP_THEME_LABEL_KEYS[preference]],
        checked: preference === preferences.theme,
        action: { kind: 'theme', preference },
      })),
    },
    {
      label: strings.language,
      choices: DESKTOP_SHELL_LOCALES.map((locale): ShellSettingsChoice => ({
        label: DESKTOP_SHELL_LOCALE_LABELS[locale],
        checked: locale === preferences.locale,
        action: { kind: 'locale', locale },
      })),
    },
    {
      label: zh ? '通知' : 'Notifications', type: 'checkbox',
      choices: switches.map(([key, label]) => ({ label, checked: p[key], action: { kind: 'notifications', preferences: { ...p, [key]: !p[key] } } })),
    },
    {
      label: zh ? '通知强调色' : 'Notification Accent',
      choices: [...([
        ['theme', zh ? '跟随主题' : 'Follow Theme'], ['deepseek', 'DeepSeek'],
        ['blue', zh ? '蓝色' : 'Blue'], ['purple', zh ? '紫色' : 'Purple'], ['green', zh ? '绿色' : 'Green'],
      ] as const).map(([accent, label]): ShellSettingsChoice => ({ label, checked: p.accent === accent, action: { kind: 'notifications', preferences: { ...p, accent } } })), { label: zh ? '自定义颜色…' : 'Custom color…', checked: p.accent.startsWith('#'), action: { kind: 'custom-notification-accent' } }],
    },
  ]
}

/**
 * Build the whole shell menu model for one preference value.
 * @param preferences - current value of the single desktop preference authority.
 * @returns the labels and settings groups both shell menus render.
 */
export function shellMenuModel(preferences: DesktopShellPreferences): ShellMenuModel {
  const strings = shellStrings(preferences.locale)
  return {
    openMainWindow: strings.openMainWindow,
    settings: strings.settings,
    groups: shellSettingsGroups(preferences),
    quit: strings.quit,
    strings,
  }
}
