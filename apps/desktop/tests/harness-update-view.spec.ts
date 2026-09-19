/** What the Harness update card shows while a staging transaction runs. */

import { describe, expect, it, vi } from 'vitest'
import {
  createHarnessUpdateView,
  type HarnessUpdateView,
  type HarnessUpdateViewOptions,
} from '../src/harness-update-view.ts'
import type {
  DesktopHarnessUpdateAction,
  DesktopHarnessUpdateView,
} from '../src/shell-protocol.ts'

interface HarnessUpdateFixtures {
  readonly view: HarnessUpdateView
  readonly published: Array<DesktopHarnessUpdateView | undefined>
  readonly cancel: ReturnType<typeof vi.fn>
  readonly retry: ReturnType<typeof vi.fn>
  readonly openDiagnostics: ReturnType<typeof vi.fn>
  readonly restart: ReturnType<typeof vi.fn>
}

/**
 * Build a card with recorded effects.
 * @param cancelVerdict - What the managed runtime answers a cancel request.
 * @returns The card and every effect and publication it produced.
 */
function updateView(cancelVerdict: 'accepted' | 'refused' | 'idle' = 'accepted'): HarnessUpdateFixtures {
  const published: Array<DesktopHarnessUpdateView | undefined> = []
  const options: HarnessUpdateViewOptions = {
    publish: (view) => { published.push(view) },
    cancel: vi.fn(() => cancelVerdict),
    retry: vi.fn(),
    openDiagnostics: vi.fn(),
    restart: vi.fn(),
  }
  return {
    view: createHarnessUpdateView(options),
    published,
    cancel: options.cancel as ReturnType<typeof vi.fn>,
    retry: options.retry as ReturnType<typeof vi.fn>,
    openDiagnostics: options.openDiagnostics as ReturnType<typeof vi.fn>,
    restart: options.restart as ReturnType<typeof vi.fn>,
  }
}

/** Open a card and report the stage its transaction reached. */
function openAtStage(fixtures: HarnessUpdateFixtures, stage: 'preparing' | 'installing' | 'verifying' | 'health'): void {
  fixtures.view.begin('update')
  if (stage === 'preparing') return
  fixtures.view.report({
    stage,
    cancellable: stage === 'installing',
  })
}

describe('Harness update card', () => {
  it('opens on the first real stage before the transaction reports anything', () => {
    const fixtures = updateView()

    expect(fixtures.view.begin('update')).toBe(true)
    expect(fixtures.published).toEqual([{
      phase: 'running',
      operation: 'update',
      stage: 'preparing',
      cancellable: true,
      cancelling: false,
      confirming: false,
      collapsed: false,
    }])
    expect(fixtures.view.running()).toBe(true)
  })

  it('keeps a second transaction from opening behind the first card', () => {
    const fixtures = updateView()
    fixtures.view.begin('update')

    expect(fixtures.view.begin('reinstall')).toBe(false)
    expect(fixtures.published).toHaveLength(1)
  })

  it('carries forward the stage and cancellability the runtime reported', () => {
    const fixtures = updateView()
    fixtures.view.begin('update')

    fixtures.view.report({ stage: 'installing', cancellable: true })
    fixtures.view.report({ stage: 'verifying', cancellable: false })

    expect(fixtures.published.at(-1)).toMatchObject({ stage: 'verifying', cancellable: false })
  })

  it('ignores a stage report that arrives with no card open', () => {
    const fixtures = updateView()

    fixtures.view.report({ stage: 'installing', cancellable: true })

    expect(fixtures.published).toEqual([])
  })

  it('reports the version pair an update replaced', () => {
    const fixtures = updateView()
    fixtures.view.begin('update', '0.1.0')

    fixtures.view.settle({ outcome: 'promoted', version: '0.2.0' }, undefined, { current: '0.2.0' })

    expect(fixtures.published.at(-1)).toEqual({
      phase: 'completed',
      operation: 'update',
      from: '0.1.0',
      to: '0.2.0',
    })
    expect(fixtures.view.running()).toBe(false)
  })

  it('names one version when a first install replaced nothing', () => {
    const fixtures = updateView()
    fixtures.view.begin('install')

    fixtures.view.settle({ outcome: 'promoted', version: '0.2.0' }, undefined, { current: '0.2.0' })

    expect(fixtures.published.at(-1)).toEqual({
      phase: 'completed',
      operation: 'install',
      to: '0.2.0',
    })
  })

  it('never reads a reinstall as an upgrade over the retained rollback target', () => {
    const fixtures = updateView()
    // A reinstall promotes the version already in use, so nothing was replaced.
    fixtures.view.begin('reinstall', '1.47.0')

    fixtures.view.settle({ outcome: 'promoted', version: '1.47.0' }, undefined, { current: '1.47.0' })

    // The only source of a version to come from is the version in use before the
    // transaction, so a reinstall can never be drawn as an upgrade.
    expect(fixtures.published.at(-1)).toEqual({ phase: 'completed', operation: 'reinstall', to: '1.47.0' })
  })

  it('takes the version pair from before the transaction, not from retention', () => {
    const fixtures = updateView()
    fixtures.view.begin('update', '1.46.1')

    fixtures.view.settle({ outcome: 'promoted', version: '1.47.0' }, undefined, { current: '1.47.0' })

    expect(fixtures.published.at(-1)).toEqual({
      phase: 'completed',
      operation: 'update',
      from: '1.46.1',
      to: '1.47.0',
    })
  })

  it('refuses to claim success the runtime state does not carry', () => {
    const fixtures = updateView()
    fixtures.view.begin('update')

    fixtures.view.settle({ outcome: 'promoted', version: '0.2.0' }, undefined, { current: '0.1.0' })

    expect(fixtures.published.at(-1)).toEqual({
      phase: 'failed',
      operation: 'update',
      reason: 'Harness 0.2.0 is not the version in use',
    })
  })

  it('settles a thrown transaction as a failure the user can read', () => {
    const fixtures = updateView()
    fixtures.view.begin('update')

    fixtures.view.settle(undefined, 'Harness registry answered 500', {})

    expect(fixtures.published.at(-1)).toEqual({
      phase: 'failed',
      operation: 'update',
      reason: 'Harness registry answered 500',
    })
  })

  it('takes the card away for an unchanged Harness', () => {
    const fixtures = updateView()
    fixtures.view.begin('update')

    fixtures.view.settle({ outcome: 'up-to-date', version: '0.1.0' }, undefined, { current: '0.1.0' })

    expect(fixtures.published.at(-1)).toBeUndefined()
  })

  it('reports a cancellation as its own outcome, not as a failure', () => {
    const fixtures = updateView()
    fixtures.view.begin('update')

    fixtures.view.settle({ outcome: 'cancelled' }, undefined, { current: '0.1.0' })

    expect(fixtures.published.at(-1)).toEqual({ phase: 'cancelled', operation: 'update' })
  })

  it('asks before cancelling, and only asks where the runtime allows it', () => {
    const fixtures = updateView()
    openAtStage(fixtures, 'installing')

    fixtures.view.act('cancel')

    expect(fixtures.published.at(-1)).toMatchObject({ confirming: true, cancelling: false })
    expect(fixtures.cancel).not.toHaveBeenCalled()
  })

  it('does not offer to cancel a step the runtime cannot interrupt', () => {
    const fixtures = updateView()
    openAtStage(fixtures, 'verifying')

    fixtures.view.act('cancel')

    expect(fixtures.published).toHaveLength(2)
    expect(fixtures.cancel).not.toHaveBeenCalled()
  })

  it('hands the cancel to the runtime only once the user confirms it', () => {
    const fixtures = updateView()
    openAtStage(fixtures, 'preparing')
    fixtures.view.act('cancel')

    fixtures.view.act('confirm-cancel')

    expect(fixtures.cancel).toHaveBeenCalledTimes(1)
    expect(fixtures.published.at(-1)).toMatchObject({ confirming: false, cancelling: true })
  })

  it('holds no cancel the runtime refused', () => {
    const fixtures = updateView('refused')
    openAtStage(fixtures, 'preparing')

    fixtures.view.act('confirm-cancel')

    expect(fixtures.published.at(-1)).toMatchObject({ confirming: false, cancelling: false })
  })

  it('leaves the question when the user chooses to keep updating', () => {
    const fixtures = updateView()
    openAtStage(fixtures, 'installing')
    fixtures.view.act('cancel')

    fixtures.view.act('keep')

    expect(fixtures.published.at(-1)).toMatchObject({ confirming: false, cancelling: false })
    expect(fixtures.cancel).not.toHaveBeenCalled()
  })

  it('ignores a second cancel request once one is running', () => {
    const fixtures = updateView()
    openAtStage(fixtures, 'installing')
    fixtures.view.act('confirm-cancel')

    fixtures.view.act('cancel')

    expect(fixtures.cancel).toHaveBeenCalledTimes(1)
    expect(fixtures.published.at(-1)).toMatchObject({ confirming: false, cancelling: true })
  })

  it('hides the card without stopping the transaction behind it', () => {
    const fixtures = updateView()
    openAtStage(fixtures, 'installing')

    fixtures.view.act('collapse')

    expect(fixtures.published.at(-1)).toMatchObject({ phase: 'running', collapsed: true })
    expect(fixtures.view.running()).toBe(true)
    expect(fixtures.cancel).not.toHaveBeenCalled()
  })

  it('cannot be dismissed out from under a running transaction', () => {
    const fixtures = updateView()
    openAtStage(fixtures, 'installing')

    fixtures.view.act('dismiss')

    expect(fixtures.published.at(-1)).toMatchObject({ phase: 'running' })
    expect(fixtures.view.running()).toBe(true)
  })

  const settledActions: readonly DesktopHarnessUpdateAction[] = ['dismiss', 'retry', 'details', 'restart']
  it.each(settledActions)('acts on a settled card: %s', (action) => {
    const fixtures = updateView()
    fixtures.view.begin('update')
    fixtures.view.settle({ outcome: 'failed', reason: 'Harness 0.2.0 failed its health check' }, undefined, {})
    fixtures.published.length = 0

    fixtures.view.act(action)

    if (action === 'dismiss') expect(fixtures.published).toEqual([undefined])
    else expect(fixtures.published).toEqual([])
  })

  it('retries the operation the card was reporting on', () => {
    const fixtures = updateView()
    fixtures.view.begin('reinstall')
    fixtures.view.settle({ outcome: 'cancelled' }, undefined, {})

    fixtures.view.act('retry')

    expect(fixtures.retry).toHaveBeenCalledWith('reinstall')
  })

  it('will not retry, dismiss, or restart while a transaction is still running', () => {
    const fixtures = updateView()
    openAtStage(fixtures, 'health')

    fixtures.view.act('retry')
    fixtures.view.act('dismiss')
    fixtures.view.act('restart')

    expect(fixtures.retry).not.toHaveBeenCalled()
    expect(fixtures.restart).not.toHaveBeenCalled()
    expect(fixtures.published.at(-1)).toMatchObject({ phase: 'running' })
  })

  it('restarts only from the completed card, and takes the card with it', () => {
    const fixtures = updateView()
    fixtures.view.begin('update')
    fixtures.view.settle({ outcome: 'promoted', version: '0.2.0' }, undefined, { current: '0.2.0' })
    fixtures.published.length = 0

    fixtures.view.act('restart')

    expect(fixtures.restart).toHaveBeenCalledTimes(1)
    expect(fixtures.published).toEqual([undefined])
  })

  it('leaves the running Harness alone when a completed card is dismissed', () => {
    const fixtures = updateView()
    fixtures.view.begin('update', '0.1.0')
    fixtures.view.settle({ outcome: 'promoted', version: '0.2.0' }, undefined, { current: '0.2.0' })
    fixtures.published.length = 0

    fixtures.view.act('dismiss')

    // The promoted version still takes effect only when the user restarts it,
    // from this card or from the Harness menu later.
    expect(fixtures.restart).not.toHaveBeenCalled()
    expect(fixtures.published).toEqual([undefined])
  })

  it('opens the diagnostics log from a failure without hiding it', () => {
    const fixtures = updateView()
    fixtures.view.begin('update')
    fixtures.view.settle({ outcome: 'failed', reason: 'the install was substituted' }, undefined, {})
    fixtures.published.length = 0

    fixtures.view.act('details')

    expect(fixtures.openDiagnostics).toHaveBeenCalledTimes(1)
    expect(fixtures.published).toEqual([])
  })

  it('ignores every request while no card has been opened', () => {
    const fixtures = updateView()

    for (const action of ['cancel', 'keep', 'confirm-cancel', 'collapse'] as const) {
      fixtures.view.act(action)
    }

    expect(fixtures.published).toEqual([])
    expect(fixtures.cancel).not.toHaveBeenCalled()
  })

  it('settles nothing after the card has already settled', () => {
    const fixtures = updateView()
    fixtures.view.begin('update')
    fixtures.view.settle({ outcome: 'promoted', version: '0.2.0' }, undefined, { current: '0.2.0' })
    fixtures.published.length = 0

    fixtures.view.report({ stage: 'health', cancellable: false })
    fixtures.view.settle({ outcome: 'failed', reason: 'late' }, undefined, {})

    expect(fixtures.published).toEqual([])
  })
})
