import { describe, expect, it, vi } from 'vitest'
import {
  createDesktopThemeCoordinator,
  isDesktopThemePreference,
  isDesktopThemeState,
} from '../src/desktop-theme-sync.ts'

describe('desktop theme synchronization', () => {
  it('accepts only the closed preference and state unions', () => {
    expect(isDesktopThemePreference('light')).toBe(true)
    expect(isDesktopThemePreference('dark')).toBe(true)
    expect(isDesktopThemePreference('system')).toBe(true)
    expect(isDesktopThemePreference('auto')).toBe(false)
    expect(isDesktopThemeState({ preference: 'dark', scheme: 'dark' })).toBe(true)
    expect(isDesktopThemeState({ preference: 'system', scheme: 'light' })).toBe(true)
    expect(isDesktopThemeState({
      preference: 'dark',
      scheme: 'dark',
      backgroundColor: '#000000',
    })).toBe(true)
    expect(isDesktopThemeState({
      preference: 'dark',
      scheme: 'dark',
      backgroundColor: 'url(https://example.com/a.png)',
    })).toBe(false)
    expect(isDesktopThemeState({ preference: 'dark', scheme: 'system' })).toBe(false)
    expect(isDesktopThemeState(null)).toBe(false)
  })

  it('lets only the initial selected mode establish authority', () => {
    const onChange = vi.fn()
    const applyHarness = vi.fn()
    const applyChat = vi.fn()
    const coordinator = createDesktopThemeCoordinator({
      initialMode: 'harness',
      initialSystemScheme: 'light',
      onChange,
    })
    coordinator.connect('harness', applyHarness)
    coordinator.connect('chat', applyChat)

    coordinator.report('chat', { preference: 'dark', scheme: 'dark' })
    expect(coordinator.snapshot()).toEqual({
      selected: 'harness',
      preference: 'system',
      scheme: 'light',
      authoritative: false,
    })
    expect(onChange).not.toHaveBeenCalled()

    coordinator.report('harness', { preference: 'dark', scheme: 'dark' })
    expect(coordinator.snapshot()).toEqual({
      selected: 'harness',
      preference: 'dark',
      scheme: 'dark',
      authoritative: true,
    })
    expect(applyHarness).not.toHaveBeenCalled()
    expect(applyChat).toHaveBeenCalledOnce()
    expect(applyChat).toHaveBeenLastCalledWith('dark')
    expect(onChange).toHaveBeenCalledOnce()
  })

  it('corrects a hidden disagreement without publishing a loop', () => {
    const onChange = vi.fn()
    const applyChat = vi.fn()
    const coordinator = createDesktopThemeCoordinator({
      initialMode: 'harness',
      initialSystemScheme: 'light',
      onChange,
    })
    coordinator.connect('chat', applyChat)
    coordinator.report('harness', { preference: 'system', scheme: 'light' })
    onChange.mockClear()
    applyChat.mockClear()

    coordinator.report('chat', { preference: 'dark', scheme: 'dark' })

    expect(applyChat).toHaveBeenCalledOnce()
    expect(applyChat).toHaveBeenCalledWith('system')
    expect(onChange).not.toHaveBeenCalled()
    expect(coordinator.snapshot().preference).toBe('system')
  })

  it('applies established state to late connections and mode handoff', () => {
    const coordinator = createDesktopThemeCoordinator({
      initialMode: 'harness',
      initialSystemScheme: 'light',
      onChange: vi.fn(),
    })
    coordinator.report('harness', { preference: 'dark', scheme: 'dark' })
    const applyChat = vi.fn()

    const disconnect = coordinator.connect('chat', applyChat)
    expect(applyChat).toHaveBeenCalledWith('dark')
    coordinator.select('chat')
    expect(coordinator.snapshot().selected).toBe('chat')
    expect(applyChat).toHaveBeenCalledTimes(2)

    coordinator.report('chat', { preference: 'light', scheme: 'light' })
    expect(coordinator.snapshot()).toMatchObject({ preference: 'light', scheme: 'light' })

    disconnect()
    disconnect()
    coordinator.select('harness')
    coordinator.report('harness', { preference: 'system', scheme: 'dark' })
    expect(applyChat).toHaveBeenCalledTimes(2)
  })

  it('updates only the resolved scheme while following the system', () => {
    const onChange = vi.fn()
    const coordinator = createDesktopThemeCoordinator({
      initialMode: 'harness',
      initialSystemScheme: 'light',
      onChange,
    })
    coordinator.report('harness', { preference: 'system', scheme: 'light' })
    onChange.mockClear()

    coordinator.systemChanged('dark')
    expect(coordinator.snapshot()).toMatchObject({ preference: 'system', scheme: 'dark' })
    expect(onChange).toHaveBeenCalledOnce()

    coordinator.report('harness', { preference: 'light', scheme: 'light' })
    onChange.mockClear()
    coordinator.systemChanged('dark')
    expect(coordinator.snapshot()).toMatchObject({ preference: 'light', scheme: 'light' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('does not publish duplicate active reports', () => {
    const onChange = vi.fn()
    const coordinator = createDesktopThemeCoordinator({
      initialMode: 'chat',
      initialSystemScheme: 'dark',
      onChange,
    })
    const state = { preference: 'dark', scheme: 'dark' } as const
    coordinator.report('chat', state)
    coordinator.report('chat', state)
    expect(onChange).toHaveBeenCalledOnce()
  })
})

describe('the desktop preference authority over system changes', () => {
  function coordinatorWith(initialPreference: 'system' | 'light' | 'dark') {
    const applied: Array<[string, string]> = []
    const coordinator = createDesktopThemeCoordinator({
      initialMode: 'harness',
      initialSystemScheme: 'dark',
      initialPreference,
      onChange: () => {},
    })
    coordinator.connect('harness', (preference) => { applied.push(['harness', preference]) })
    coordinator.connect('chat', (preference) => { applied.push(['chat', preference]) })
    applied.length = 0
    return { coordinator, applied }
  }

  it('starts authoritative from a persisted choice and tells each surface on connect', () => {
    const applied: Array<[string, string]> = []
    const coordinator = createDesktopThemeCoordinator({
      initialMode: 'harness',
      initialSystemScheme: 'dark',
      initialPreference: 'light',
      onChange: () => {},
    })
    expect(coordinator.snapshot()).toMatchObject({ preference: 'light', scheme: 'light', authoritative: true })
    coordinator.connect('harness', (preference) => { applied.push(['harness', preference]) })
    coordinator.connect('chat', (preference) => { applied.push(['chat', preference]) })
    // Told, not asked: a surface connecting later receives the desktop choice.
    expect(applied).toEqual([['harness', 'light'], ['chat', 'light']])
  })

  it('updates its own resolved scheme on an operating-system change without re-pinning surfaces', () => {
    const { coordinator, applied } = coordinatorWith('system')
    coordinator.systemChanged('light')
    // The shell repaints from the coordinator's scheme; surfaces keep their own
    // `system` preference rather than being handed a palette to pin.
    expect(applied).toEqual([])
    expect(coordinator.snapshot()).toMatchObject({ preference: 'system', scheme: 'light' })
  })

  it('does not re-announce while an explicit palette is pinned', () => {
    const { coordinator, applied } = coordinatorWith('light')
    coordinator.systemChanged('dark')
    expect(applied).toEqual([])
    expect(coordinator.snapshot()).toMatchObject({ preference: 'light', scheme: 'light' })
  })

  it('pushes an explicit desktop choice to every surface, the selected one included', () => {
    const { coordinator, applied } = coordinatorWith('system')
    coordinator.setPreference('dark')
    expect(applied).toEqual([['harness', 'dark'], ['chat', 'dark']])
    expect(coordinator.snapshot()).toMatchObject({ preference: 'dark', scheme: 'dark', authoritative: true })
  })

  it('resolves a later switch back to system against the current operating system', () => {
    const { coordinator, applied } = coordinatorWith('light')
    coordinator.systemChanged('light')
    coordinator.setPreference('system')
    expect(coordinator.snapshot()).toMatchObject({ preference: 'system', scheme: 'light' })
    expect(applied).toEqual([['harness', 'system'], ['chat', 'system']])
  })

  it('pushes system itself on an explicit choice, so surfaces resolve it afresh', () => {
    const { coordinator, applied } = coordinatorWith('dark')
    coordinator.setPreference('system')
    // initialSystemScheme was dark and nothing changed it, so system resolves dark.
    expect(applied).toEqual([['harness', 'system'], ['chat', 'system']])
    expect(coordinator.snapshot()).toMatchObject({ preference: 'system', scheme: 'dark' })
  })
})
