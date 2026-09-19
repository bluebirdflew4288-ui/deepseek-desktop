/**
 * The shell's view of one staging Harness transaction.
 *
 * The managed runtime owns what a transaction does; this module owns what the
 * user is told while it runs and after it settles. One state machine holds the
 * card's state so it cannot open twice, cannot be dismissed out from under a
 * running transaction, and cannot outlive the transaction it describes.
 *
 * Every stage and safety claim it publishes was reported by the runtime. This
 * module runs no timers and invents no progress: between what the runtime last
 * reported and what the transaction produced, it holds exactly one state.
 */

import type {
  ManagedHarnessCancellation,
  ManagedHarnessTransaction,
  ManagedHarnessTransactionProgress,
} from './managed-harness.ts'
import type {
  DesktopHarnessUpdateAction,
  DesktopHarnessUpdateOperation,
  DesktopHarnessUpdateView,
} from './shell-protocol.ts'

function assertNever(value: never): never {
  throw new Error(`unsupported Harness update card action: ${String(value)}`)
}

/** Program versions retained once a transaction has settled. */
export interface HarnessUpdateRetention {
  /** Version now promoted and launchable. */
  readonly current?: string
}

/** Effects the card asks the composition root to perform. */
export interface HarnessUpdateViewOptions {
  /**
   * Replace the card's published state.
   * @param view - State to render, or undefined to take the card away.
   */
  readonly publish: (view: DesktopHarnessUpdateView | undefined) => void
  /**
   * Ask the managed runtime to stop the staging transaction that is running.
   * @returns Whether the request will take effect.
   */
  readonly cancel: () => ManagedHarnessCancellation
  /**
   * Start the transaction the card is retrying. The card reopens through
   * {@link HarnessUpdateView.begin} as the caller starts it.
   * @param operation - Transaction to start again.
   */
  readonly retry: (operation: DesktopHarnessUpdateOperation) => void
  /** Reveal the managed Harness diagnostics log. */
  readonly openDiagnostics: () => void
  /** Stop and start the Harness surface so the promoted version takes effect. */
  readonly restart: () => void
}

/** The card the shell shows for one staging transaction. */
export interface HarnessUpdateView {
  /**
   * Open the card for a transaction about to start.
   * @param operation - Transaction the user picked.
   * @param outgoing - Version the desktop launches now, which the transaction is
   * about to replace. Read before the transaction starts, because a reinstall
   * leaves the retained rollback target where it was and so cannot be asked which
   * version it replaced.
   * @returns Whether the card was free. A caller starts nothing when it is not.
   */
  begin(operation: DesktopHarnessUpdateOperation, outgoing?: string): boolean
  /**
   * Record the stage the running transaction reached.
   * @param progress - Stage and cancellability the runtime reported.
   */
  report(progress: ManagedHarnessTransactionProgress): void
  /**
   * Settle the card against what the transaction produced.
   * @param transaction - Outcome the runtime returned.
   * @param failure - Why the call itself could not produce an outcome, when it
   * threw instead of returning one.
   * @param retained - Versions the runtime retains now.
   */
  settle(transaction: ManagedHarnessTransaction | undefined, failure: string | undefined, retained: HarnessUpdateRetention): void
  /**
   * Act on one request from the card.
   * @param action - Request the user made of the card.
   */
  act(action: DesktopHarnessUpdateAction): void
  /**
   * Whether a transaction is still running behind the card.
   * @returns Whether the card holds an unfinished transaction.
   */
  running(): boolean
}

/**
 * Create the shell's view of staging Harness transactions.
 * @param options - Publisher and the effects the card can ask for.
 * @returns A view holding at most one transaction's state.
 */
export function createHarnessUpdateView(options: HarnessUpdateViewOptions): HarnessUpdateView {
  let view: DesktopHarnessUpdateView | undefined
  /**
   * Version the open transaction started from. Only `begin` writes it, and only a
   * running card reads it, so it always belongs to the transaction being shown.
   */
  let outgoing: string | undefined

  const publish = (next: DesktopHarnessUpdateView | undefined): void => {
    view = next
    options.publish(next)
  }

  /** The running card, absent when nothing is running. */
  const runningView = (): Extract<DesktopHarnessUpdateView, { phase: 'running' }> | undefined =>
    view !== undefined && view.phase === 'running' ? view : undefined

  /** Report a transaction that never produced an outcome as one that failed. */
  const fail = (operation: DesktopHarnessUpdateOperation, reason: string): void => {
    publish({ phase: 'failed', operation, reason })
  }

  return {
    begin(operation, from) {
      if (runningView() !== undefined) return false
      outgoing = from
      publish({
        phase: 'running',
        operation,
        stage: 'preparing',
        cancellable: true,
        cancelling: false,
        confirming: false,
        collapsed: false,
      })
      return true
    },

    report(progress) {
      const running = runningView()
      if (running === undefined) return
      publish({ ...running, stage: progress.stage, cancellable: progress.cancellable })
    },

    settle(transaction, failure, retained) {
      const running = runningView()
      if (running === undefined) return
      if (transaction === undefined) {
        fail(running.operation, failure ?? 'the Harness transaction did not complete')
        return
      }
      switch (transaction.outcome) {
        case 'promoted': {
          // A promoted version is reported only once the runtime's own state
          // names it, so the card cannot claim a version nothing verified.
          if (retained.current !== transaction.version) {
            fail(running.operation, `Harness ${transaction.version} is not the version in use`)
            return
          }
          // A version pair is shown only when the running version actually
          // changed. A reinstall promotes the version already in use, and a first
          // install replaced nothing, so neither has a version to come from.
          const replaced = outgoing === undefined || outgoing === transaction.version
            ? undefined
            : outgoing
          publish({
            phase: 'completed',
            operation: running.operation,
            ...(replaced === undefined ? {} : { from: replaced }),
            to: transaction.version,
          })
          return
        }
        case 'cancelled':
          publish({ phase: 'cancelled', operation: running.operation })
          return
        case 'failed':
          fail(running.operation, transaction.reason)
          return
        case 'up-to-date':
        case 'rolled-back':
          // Neither changes what the card would be reporting on: an unchanged
          // Harness is told by the caller's own result message, and a rollback is
          // not a transaction the card runs behind.
          publish(undefined)
          return
        default:
          assertNever(transaction)
      }
    },

    act(action) {
      const running = runningView()
      switch (action) {
        case 'cancel':
          // The card explains an uncancellable stage itself, so a request that
          // arrives anyway is answered from what the runtime last reported.
          if (running === undefined || !running.cancellable || running.cancelling) return
          publish({ ...running, confirming: true })
          return
        case 'keep':
          if (running === undefined) return
          publish({ ...running, confirming: false })
          return
        case 'confirm-cancel': {
          if (running === undefined || running.cancelling) return
          const verdict = options.cancel()
          if (verdict !== 'accepted') {
            publish({ ...running, confirming: false })
            return
          }
          publish({ ...running, confirming: false, cancelling: true })
          return
        }
        case 'collapse':
          if (running === undefined) return
          publish({ ...running, confirming: false, collapsed: true })
          return
        case 'dismiss':
          if (view === undefined || running !== undefined) return
          publish(undefined)
          return
        case 'retry': {
          if (view === undefined || view.phase === 'running') return
          options.retry(view.operation)
          return
        }
        case 'details':
          if (view === undefined) return
          options.openDiagnostics()
          return
        case 'restart':
          if (view === undefined || view.phase !== 'completed') return
          options.restart()
          publish(undefined)
          return
        default:
          assertNever(action)
      }
    },

    running() {
      return runningView() !== undefined
    },
  }
}
