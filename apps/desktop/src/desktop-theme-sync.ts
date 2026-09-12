/** Active-mode authority and propagation for the desktop theme preference. */

import type { DesktopMode } from './desktop-mode.ts'
import {
  isDesktopColorScheme,
  isDesktopThemeBackgroundColor,
  isDesktopThemePreference,
  type DesktopColorScheme,
  type DesktopThemePreference,
} from './desktop-theme.ts'

export { isDesktopThemePreference } from './desktop-theme.ts'

/** Closed IPC channels shared by the two trusted theme preloads. */
export const DESKTOP_THEME_CHANNELS = {
  report: 'dsh-desktop:theme-report',
  apply: 'dsh-desktop:theme-apply',
  adapterError: 'dsh-desktop:theme-adapter-error',
} as const

/** Preference and resolved color scheme reported by one desktop renderer. */
export interface DesktopThemeState {
  readonly preference: DesktopThemePreference
  readonly scheme: DesktopColorScheme
  readonly backgroundColor?: string
}

/** Detached coordinator state for presentation and tests. */
export interface DesktopThemeSnapshot extends DesktopThemeState {
  readonly authoritative: boolean
  readonly selected: DesktopMode
}

/** Dependencies for one in-memory desktop theme coordinator. */
export interface DesktopThemeCoordinatorOptions {
  readonly initialMode: DesktopMode
  readonly initialSystemScheme: DesktopColorScheme
  /**
   * Desktop-owned preference to start from. Supplying it makes the desktop the
   * authority immediately, so a connected surface receives the persisted choice
   * instead of the coordinator waiting for that surface to report one. Omitting
   * it keeps the original behavior: no authority until a surface reports.
   */
  readonly initialPreference?: DesktopThemePreference
  readonly onChange: (snapshot: DesktopThemeSnapshot) => void
}

/** Active-mode theme operations used by the desktop composition root. */
export interface DesktopThemeCoordinator {
  /** Accept a renderer report, using only the selected mode as an authority. */
  report(mode: DesktopMode, state: DesktopThemeState): void
  /** Connect one mode's preference writer and return its idempotent disposer. */
  connect(mode: DesktopMode, apply: (preference: DesktopThemePreference) => void): () => void
  /** Select the new authority and apply established state before it reports. */
  select(mode: DesktopMode): void
  /** Update the resolved scheme while the shared preference follows the system. */
  systemChanged(scheme: DesktopColorScheme): void
  /**
   * Take the desktop preference authority: set the shared preference, resolve
   * its scheme, and push it to every connected surface — the selected one
   * included, because the desktop choice outranks whatever a surface reported.
   * @param preference - the desktop-owned appearance choice.
   */
  setPreference(preference: DesktopThemePreference): void
  /** Return a detached view of the current coordinator state. */
  snapshot(): DesktopThemeSnapshot
}

/**
 * Validate one renderer theme report.
 * @param value - Value received from a sandboxed preload.
 * @returns Whether the value contains one accepted preference and resolved scheme.
 */
export function isDesktopThemeState(value: unknown): value is DesktopThemeState {
  if (typeof value !== 'object' || value === null) return false
  const state = value as { preference?: unknown; scheme?: unknown; backgroundColor?: unknown }
  return isDesktopThemePreference(state.preference)
    && isDesktopColorScheme(state.scheme)
    && (state.backgroundColor === undefined || isDesktopThemeBackgroundColor(state.backgroundColor))
}

function sameState(left: DesktopThemeState, right: DesktopThemeState): boolean {
  return left.preference === right.preference
    && left.scheme === right.scheme
    && left.backgroundColor === right.backgroundColor
}

/**
 * Create an in-memory coordinator that propagates only active-mode changes.
 * @param options - Initial selection, operating-system fallback, and presentation listener.
 * @returns Theme operations whose connections are owned by individual surfaces.
 */
export function createDesktopThemeCoordinator(options: DesktopThemeCoordinatorOptions): DesktopThemeCoordinator {
  let selected = options.initialMode
  let systemScheme = options.initialSystemScheme
  const initialPreference = options.initialPreference
  // A persisted desktop choice is authoritative from the first moment, so a
  // surface connecting later is told the preference rather than asked for one.
  let authoritative = initialPreference !== undefined
  let state: DesktopThemeState = {
    preference: initialPreference ?? 'system',
    scheme: initialPreference === undefined || initialPreference === 'system'
      ? systemScheme
      : initialPreference,
  }
  const targets = new Map<DesktopMode, (preference: DesktopThemePreference) => void>()

  const snapshot = (): DesktopThemeSnapshot => ({ ...state, authoritative, selected })
  const publish = (): void => { options.onChange(snapshot()) }
  const applyToOtherModes = (source: DesktopMode): void => {
    for (const [mode, apply] of targets) {
      if (mode !== source) apply(state.preference)
    }
  }

  return {
    report(mode, report) {
      if (mode !== selected) {
        if (authoritative && report.preference !== state.preference) {
          targets.get(mode)?.(state.preference)
        }
        return
      }
      if (authoritative && sameState(state, report)) return
      authoritative = true
      state = { ...report }
      publish()
      applyToOtherModes(mode)
    },
    connect(mode, apply) {
      if (targets.has(mode)) throw new Error(`desktop theme target is already connected: ${mode}`)
      targets.set(mode, apply)
      if (authoritative) apply(state.preference)
      let connected = true
      return () => {
        if (!connected) return
        connected = false
        if (targets.get(mode) === apply) targets.delete(mode)
      }
    },
    select(mode) {
      selected = mode
      if (authoritative) targets.get(mode)?.(state.preference)
    },
    systemChanged(scheme) {
      // Tracked even while an explicit palette is pinned, so switching back to
      // `system` resolves against the scheme the operating system reports now.
      systemScheme = scheme
      if (state.preference !== 'system' || state.scheme === scheme) return
      state = { ...state, scheme }
      publish()
      // NOTE: deliberately no re-announcement here. A surface that resolved
      // `system` itself pins the result (the Harness writes an inline
      // color-scheme) and ignores a repeated `system`, so it does not track a
      // live operating-system change. Pushing the RESOLVED palette instead would
      // fix that but downgrades each surface's own stored preference from
      // `system` to a pinned palette, which the dual-mode Electron contract
      // asserts against. Left as a product decision rather than a silent
      // trade-off.
    },
    setPreference(preference) {
      if (authoritative && state.preference === preference) return
      // The previous background color was sampled under the previous palette, so
      // it is dropped and the surfaces re-report their own.
      state = { preference, scheme: preference === 'system' ? systemScheme : preference }
      authoritative = true
      publish()
      for (const apply of targets.values()) apply(preference)
    },
    snapshot,
  }
}
