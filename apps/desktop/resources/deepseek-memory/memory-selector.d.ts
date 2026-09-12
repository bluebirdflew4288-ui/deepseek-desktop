export interface MemoryRecord {
  readonly id: number
  readonly type: 'user' | 'feedback' | 'topic' | 'reference'
  readonly name: string
  readonly content: string
  readonly tags: readonly string[]
  readonly pinned: boolean
  readonly createdAt: number
  readonly updatedAt: number
  readonly accessCount: number
  readonly lastAccessedAt: number
}

export interface AugmentedPrompt {
  readonly prompt: string
  readonly usedMemoryIds: number[]
}

export function selectMemories(
  prompt: string,
  memories: readonly MemoryRecord[],
  budget?: number,
): MemoryRecord[]

export function buildAugmentedPrompt(
  prompt: string,
  memories: readonly MemoryRecord[],
): AugmentedPrompt
