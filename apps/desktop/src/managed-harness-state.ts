/**
 * Durable version state for the desktop-managed Harness program directory.
 *
 * One document, one writer. It records which program versions are retained and
 * which operation was in flight, so a crash between staging and promotion
 * leaves the last verified version in charge rather than a half-switched one.
 */

import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { isManagedHarnessVersionName } from './managed-harness-paths.ts'

/** Document version written by this build. */
export const MANAGED_HARNESS_STATE_VERSION = 1

/** Transaction the state file can be mid-way through. */
export type ManagedHarnessOperation = 'install' | 'update' | 'reinstall' | 'rollback'

/** The operations the state file recognizes, in the order they are written. */
const OPERATIONS = new Set<ManagedHarnessOperation>(['install', 'update', 'reinstall', 'rollback'])

/** In-flight transaction recovered after an interrupted run. */
export interface ManagedHarnessPending {
  /** Transaction that had not completed when the application stopped. */
  readonly operation: ManagedHarnessOperation
  /** Version that transaction was preparing. */
  readonly version: string
}

/** Retained Harness program versions and the transaction that produced them. */
export interface ManagedHarnessState {
  /** Version the desktop launches. Absent until the first install completes. */
  readonly current?: string
  /** Version kept for rollback. Absent until a second install completes. */
  readonly previous?: string
  /**
   * Transaction interrupted by a crash. Its version was never promoted, so
   * recovery discards that version's staging directory and clears this field.
   */
  readonly pending?: ManagedHarnessPending
}

/** State asserting that no program version has been promoted yet. */
export const EMPTY_MANAGED_HARNESS_STATE: ManagedHarnessState = Object.freeze({})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readVersion(candidate: Record<string, unknown>, field: 'current' | 'previous'): string | undefined {
  const value = candidate[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !isManagedHarnessVersionName(value)) {
    throw new Error(`managed Harness state has an invalid ${field} version`)
  }
  return value
}

function readPending(candidate: Record<string, unknown>): ManagedHarnessPending | undefined {
  const value = candidate.pending
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error('managed Harness state has an invalid pending transaction')
  const { operation, version } = value
  if (typeof operation !== 'string' || !OPERATIONS.has(operation as ManagedHarnessOperation)) {
    throw new Error('managed Harness state has an unknown pending operation')
  }
  if (typeof version !== 'string' || !isManagedHarnessVersionName(version)) {
    throw new Error('managed Harness state has an invalid pending version')
  }
  return { operation: operation as ManagedHarnessOperation, version }
}

/**
 * Validate one serialized state document.
 * @param content - JSON text read from the state file.
 * @returns The validated state.
 * @throws When the text is not a document this build recognizes. Callers treat
 * that as an unusable managed directory rather than guessing a version.
 */
export function parseManagedHarnessState(content: string): ManagedHarnessState {
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    throw new Error('managed Harness state is invalid')
  }
  if (!isRecord(value)) throw new Error('managed Harness state is invalid')
  if (value.schemaVersion !== MANAGED_HARNESS_STATE_VERSION) {
    throw new Error('managed Harness state was written by another build')
  }
  const current = readVersion(value, 'current')
  const previous = readVersion(value, 'previous')
  const pending = readPending(value)
  if (previous !== undefined && previous === current) {
    throw new Error('managed Harness state names the same version twice')
  }
  return {
    ...current === undefined ? {} : { current },
    ...previous === undefined ? {} : { previous },
    ...pending === undefined ? {} : { pending },
  }
}

/**
 * Serialize one state document.
 * @param state - State to persist.
 * @returns JSON text with a trailing newline.
 */
export function serializeManagedHarnessState(state: ManagedHarnessState): string {
  const document: Record<string, unknown> = { schemaVersion: MANAGED_HARNESS_STATE_VERSION }
  if (state.current !== undefined) document.current = state.current
  if (state.previous !== undefined) document.previous = state.previous
  if (state.pending !== undefined) document.pending = { ...state.pending }
  return `${JSON.stringify(document)}\n`
}

/**
 * Read the durable version state.
 * @param filename - JSON file holding the state.
 * @returns The validated state, or the empty state when no install has run.
 * @throws When the file exists but this build cannot validate it.
 */
export async function loadManagedHarnessState(filename: string): Promise<ManagedHarnessState> {
  let content: string
  try {
    content = await readFile(filename, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return EMPTY_MANAGED_HARNESS_STATE
    throw error
  }
  return parseManagedHarnessState(content)
}

/**
 * Persist the complete version state using an owner-only atomic replacement.
 * @param filename - JSON file receiving the state.
 * @param state - Whole state; every field is written, so nothing is dropped.
 */
export async function saveManagedHarnessState(filename: string, state: ManagedHarnessState): Promise<void> {
  await writeFileAtomic(filename, serializeManagedHarnessState(state), { mode: 0o600, dirMode: 0o700 })
}

/**
 * Drop an interrupted transaction, keeping both retained versions.
 *
 * A pending version was never promoted, so the versions named by `current` and
 * `previous` are still the last ones that passed a health check.
 * @param state - State read at startup.
 * @returns The state to persist after recovery, unchanged when nothing was pending.
 */
export function recoverManagedHarnessState(state: ManagedHarnessState): ManagedHarnessState {
  if (state.pending === undefined) return state
  const { pending: _discarded, ...rest } = state
  return rest
}

/**
 * State after one transaction promoted a version.
 *
 * Promoting a different version makes the outgoing current the rollback target,
 * so exactly two program versions survive and anything older is unreferenced and
 * eligible for cleanup. Re-promoting the version already current, which is what a
 * reinstall does, keeps the rollback target it already had.
 * @param state - State before the transaction.
 * @param version - Version that passed its health check.
 * @returns The state to persist once that version's directory is in place.
 */
export function promoteManagedHarnessVersion(state: ManagedHarnessState, version: string): ManagedHarnessState {
  if (state.current === version || state.current === undefined) {
    return {
      current: version,
      ...(state.previous === undefined ? {} : { previous: state.previous }),
    }
  }
  return { current: version, previous: state.current }
}
