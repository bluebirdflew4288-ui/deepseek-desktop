const MAX_RESPONSE_CHARS = 2_000_000
const MAX_CALLS = 10
const MEMORY_SAVE_TAG = /<\/?memory_save>/giu

/** Parse bounded direct Memory save calls without backtracking over malformed output. */
export function parseMemorySaveCalls(text) {
  if (typeof text !== 'string' || text.length > MAX_RESPONSE_CHARS) return []
  const calls = []
  let bodyStart
  for (const match of text.matchAll(MEMORY_SAVE_TAG)) {
    if (match[0][1] !== '/') {
      bodyStart = match.index + match[0].length
      continue
    }
    if (bodyStart === undefined) continue
    const body = text.slice(bodyStart, match.index).trim()
    bodyStart = undefined
    try {
      const value = JSON.parse(body)
      if (value && typeof value === 'object' && !Array.isArray(value)) calls.push(value)
    } catch { /* malformed model output is ignored without affecting Chat */ }
    if (calls.length >= MAX_CALLS) break
  }
  return calls
}
