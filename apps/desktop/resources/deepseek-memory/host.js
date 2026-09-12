import {
  deleteMemory,
  exportMemoryJson,
  getAllMemories,
  importMemoryJson,
  saveMemory,
  touchMemories,
  updateMemory,
} from './memory-store.js'
import { parseMemorySaveCalls } from './memory-call-parser.js'
import { buildAugmentedPrompt, selectMemories } from './memory-selector.js'

function response(ok, value) {
  return ok ? { ok: true, value } : { ok: false, error: value instanceof Error ? value.message : String(value) }
}

async function saveAutomaticMemories(text) {
  const existing = await getAllMemories()
  const seen = new Set(existing.map(memory => memory.content.toLowerCase().replace(/\s+/g, ' ').trim()))
  const calls = parseMemorySaveCalls(text)
  const actions = []
  for (const [callIndex, value] of calls.entries()) {
    const content = typeof value.content === 'string'
      ? value.content.toLowerCase().replace(/\s+/g, ' ').trim()
      : ''
    if (!content || seen.has(content)) continue
    try {
      const id = await saveMemory({
        type: value.type,
        name: value.name,
        content: value.content,
        description: value.name,
        tags: value.tags,
        pinned: false,
      })
      seen.add(content)
      actions.push({ name: 'memory_save', id })
    } catch (error) {
      /* one invalid model call does not block later valid calls */
    }
  }
  return actions
}

async function handle(message) {
  if (!message || typeof message !== 'object') throw new Error('Memory request must be an object')
  switch (message.type) {
    case 'MEMORY_PING': return { runtimeId: chrome.runtime.id, database: 'DeepSeekPP' }
    case 'GET_MEMORIES': return getAllMemories()
    case 'SAVE_MEMORY': return { id: await saveMemory(message.payload) }
    case 'UPDATE_MEMORY': await updateMemory(message.payload); return undefined
    case 'DELETE_MEMORY': await deleteMemory(message.payload?.id); return undefined
    case 'AUGMENT_PROMPT': {
      const prompt = typeof message.payload?.prompt === 'string' ? message.payload.prompt : ''
      const selected = selectMemories(prompt, await getAllMemories())
      const augmented = buildAugmentedPrompt(prompt, selected)
      void touchMemories(augmented.usedMemoryIds).catch(() => undefined)
      return augmented
    }
    case 'MEMORY_AUTO_SAVE': return { actions: await saveAutomaticMemories(message.payload?.text) }
    case 'EXPORT_MEMORY_JSON': return exportMemoryJson()
    case 'IMPORT_MEMORY_JSON': return importMemoryJson(message.payload?.text)
    default: throw new Error(`Unsupported Memory request: ${String(message.type)}`)
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handle(message).then(value => sendResponse(response(true, value)), error => sendResponse(response(false, error)))
  return true
})

globalThis.deepseekMemoryHost = Object.freeze({
  exportJson: exportMemoryJson,
  importJson: importMemoryJson,
  ping: () => handle({ type: 'MEMORY_PING' }),
  request: handle,
})

await getAllMemories()
document.documentElement.dataset.ready = 'true'
