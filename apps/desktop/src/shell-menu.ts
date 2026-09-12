/**
 * The desktop-owned settings model rendered by both the application menu and the
 * tray menu. Both are views of one preference authority and hold no state of
 * their own, so the two menus cannot disagree and neither can drift from the
 * persisted preference.
 *
 * The groups are deliberately small — appearance and language — because the
 * Harness and Chat surfaces own their own settings and are not mirrored here.
 * A future desktop-owned setting joins this model rather than growing a second
 * menu tree.
 */

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

/** One labelled radio group, such as Appearance or Language. */
export interface ShellSettingsGroup {
  /** Group heading, rendered in the active shell locale. */
  readonly label: string
  /** Mutually exclusive choices, exactly one of them checked. */
  readonly choices: readonly ShellSettingsChoice[]
}

/** The desktop-owned preferences both shell menus render. */
export interface DesktopShellPreferences {
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
