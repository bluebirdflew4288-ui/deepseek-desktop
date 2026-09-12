export interface MemorySaveCall {
  readonly type?: unknown
  readonly name?: unknown
  readonly content?: unknown
  readonly tags?: unknown
}

export function parseMemorySaveCalls(text: unknown): MemorySaveCall[]
