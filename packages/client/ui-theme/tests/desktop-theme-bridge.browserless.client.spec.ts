// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { bindDesktopThemeBridge } from '../src/client/desktop-theme-bridge.ts'

describe('desktop ThemeRuntime bridge (browserless)', () => {
  it('returns early when no DOM exists', () => {
    // Server-side / browserless client compositions have no document or window;
    // the bridge must no-op rather than throw.
    const ctx = new Context()
    expect(() => { bindDesktopThemeBridge(ctx, {} as never) }).not.toThrow()
  })
})
