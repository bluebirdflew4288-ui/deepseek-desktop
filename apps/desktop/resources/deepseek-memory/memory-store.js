/*
 * Derived from DeepSeek++ core/memory/{schema,codec,store}.ts and
 * core/persistence/indexeddb.ts at upstream commit
 * 0a02c72b135bf2936e11aa78fd6136931ed65908. Modified into the dependency-free
 * Memory-only runtime used by DeepSeek Desktop. Licensed under Apache-2.0.
 */

export const MEMORY_DATABASE_NAME = 'DeepSeekPP'
export const MEMORY_DATABASE_VERSION = 30
export const MEMORY_TABLE_NAME = 'memories'

const MEMORY_TYPES = new Set(['user', 'feedback', 'topic', 'reference'])
let openPromise

function requiredString(value, path) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`)
  }
  return value.trim()
}

function optionalStringArray(value, path) {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw new Error(`${path} must be a string array`)
  }
  return [...new Set(value.map(item => item.trim()).filter(Boolean))]
}

function decodeDraft(value, path = 'memory') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`)
  }
  if (!MEMORY_TYPES.has(value.type)) throw new Error(`${path}.type is invalid`)
  return {
    ...(value.syncId === undefined ? {} : { syncId: requiredString(value.syncId, `${path}.syncId`) }),
    scope: 'global',
    type: value.type,
    name: requiredString(value.name, `${path}.name`).slice(0, 120),
    content: requiredString(value.content, `${path}.content`).slice(0, 8000),
    description: typeof value.description === 'string' ? value.description.slice(0, 500) : '',
    tags: optionalStringArray(value.tags ?? [], `${path}.tags`).slice(0, 24),
    pinned: value.pinned === true,
  }
}

function decodeRecord(value, path = 'memory') {
  const draft = decodeDraft(value, path)
  const finite = (field) => {
    const result = value[field]
    if (typeof result !== 'number' || !Number.isFinite(result)) {
      throw new Error(`${path}.${field} must be a finite number`)
    }
    return result
  }
  if (!Number.isSafeInteger(value.id) || value.id <= 0) {
    throw new Error(`${path}.id must be a positive safe integer`)
  }
  return {
    ...draft,
    id: value.id,
    syncId: requiredString(value.syncId, `${path}.syncId`),
    createdAt: finite('createdAt'),
    updatedAt: finite('updatedAt'),
    accessCount: finite('accessCount'),
    lastAccessedAt: finite('lastAccessedAt'),
  }
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
  })
}

function ensureIndexes(store) {
  const indexes = ['type', 'name', 'pinned', 'createdAt', 'updatedAt', 'lastAccessedAt', 'syncId', 'scope', 'projectId']
  for (const name of indexes) {
    if (!store.indexNames.contains(name)) store.createIndex(name, name, { unique: false })
  }
}

function migrateRecords(store, oldVersion) {
  if (oldVersion >= MEMORY_DATABASE_VERSION) return
  const cursor = store.openCursor()
  cursor.onsuccess = () => {
    const current = cursor.result
    if (!current) return
    const record = { ...current.value }
    if (oldVersion < 20 && (typeof record.syncId !== 'string' || !record.syncId)) {
      record.syncId = crypto.randomUUID()
    }
    if (oldVersion < 30) {
      record.scope = 'global'
      delete record.projectId
    }
    current.update(record)
    current.continue()
  }
}

export function openMemoryDatabase() {
  if (openPromise) return openPromise
  openPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(MEMORY_DATABASE_NAME, MEMORY_DATABASE_VERSION)
    request.onupgradeneeded = event => {
      const database = request.result
      const transaction = request.transaction
      if (!transaction) throw new Error('Memory database upgrade transaction is unavailable')
      const store = database.objectStoreNames.contains(MEMORY_TABLE_NAME)
        ? transaction.objectStore(MEMORY_TABLE_NAME)
        : database.createObjectStore(MEMORY_TABLE_NAME, { keyPath: 'id', autoIncrement: true })
      ensureIndexes(store)
      migrateRecords(store, event.oldVersion)
    }
    request.onsuccess = () => {
      const database = request.result
      database.onversionchange = () => database.close()
      resolve(database)
    }
    request.onerror = () => {
      openPromise = undefined
      reject(request.error ?? new Error('Memory database could not be opened'))
    }
    request.onblocked = () => {
      openPromise = undefined
      reject(new Error('Memory database upgrade was blocked by another page'))
    }
  })
  return openPromise
}

async function inStore(mode, operation) {
  const database = await openMemoryDatabase()
  if (database.version !== MEMORY_DATABASE_VERSION) {
    throw new Error(`Memory database version ${database.version} is unsupported`)
  }
  const transaction = database.transaction(MEMORY_TABLE_NAME, mode)
  const completion = transactionComplete(transaction)
  try {
    const result = await operation(transaction.objectStore(MEMORY_TABLE_NAME))
    await completion
    return result
  } catch (error) {
    try { transaction.abort() } catch { /* the original error remains authoritative */ }
    await completion.catch(() => undefined)
    throw error
  }
}

export async function getAllMemories() {
  const rows = await inStore('readonly', store => requestResult(store.getAll()))
  return rows.map((row, index) => decodeRecord(row, `memories[${index}]`))
    .sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.updatedAt - left.updatedAt)
}

export async function saveMemory(input) {
  const [id] = await importMemoriesAtomically([input])
  return id
}

export async function importMemoriesAtomically(inputs) {
  const drafts = inputs.map((value, index) => decodeDraft(value, `memories[${index}]`))
  return inStore('readwrite', async store => {
    const current = await requestResult(store.getAll())
    const bySyncId = new Map(current.filter(row => typeof row.syncId === 'string').map(row => [row.syncId, row]))
    const ids = []
    const now = Date.now()
    for (const draft of drafts) {
      const syncId = draft.syncId ?? crypto.randomUUID()
      const existing = bySyncId.get(syncId)
      const record = existing
        ? { ...existing, ...draft, id: existing.id, syncId, updatedAt: now }
        : { ...draft, syncId, createdAt: now, updatedAt: now, accessCount: 0, lastAccessedAt: now }
      const id = await requestResult(store.put(record))
      const numericId = Number(id)
      ids.push(numericId)
      bySyncId.set(syncId, { ...record, id: numericId })
    }
    return ids
  })
}

export async function updateMemory(input) {
  const record = decodeRecord(input)
  await inStore('readwrite', async store => {
    const existing = await requestResult(store.get(record.id))
    if (!existing) throw new Error(`Memory ${record.id} does not exist`)
    await requestResult(store.put({ ...record, updatedAt: Date.now() }))
  })
}

export async function deleteMemory(id) {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Memory id must be a positive integer')
  await inStore('readwrite', store => requestResult(store.delete(id)))
}

export async function touchMemories(ids) {
  const uniqueIds = [...new Set(ids.filter(id => Number.isSafeInteger(id) && id > 0))]
  if (uniqueIds.length === 0) return
  await inStore('readwrite', async store => {
    const now = Date.now()
    for (const id of uniqueIds) {
      const memory = await requestResult(store.get(id))
      if (!memory) continue
      await requestResult(store.put({
        ...memory,
        accessCount: Number(memory.accessCount ?? 0) + 1,
        lastAccessedAt: now,
      }))
    }
  })
}

export async function exportMemoryJson() {
  const memories = await getAllMemories()
  return `${JSON.stringify({
    format: 'deepseek-desktop-memory',
    version: 1,
    exportedAt: new Date().toISOString(),
    memories: memories.map(({ id: _id, ...memory }) => memory),
  }, null, 2)}\n`
}

export async function importMemoryJson(text) {
  if (typeof text !== 'string') throw new Error('Memory import must be UTF-8 JSON text')
  let document
  try { document = JSON.parse(text) } catch { throw new Error('Memory import is not valid JSON') }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('Memory import root must be an object')
  }
  if (document.format !== 'deepseek-desktop-memory' || document.version !== 1 || !Array.isArray(document.memories)) {
    throw new Error('Memory import format or version is unsupported')
  }
  const drafts = document.memories.map((memory, index) => decodeDraft(memory, `memories[${index}]`))
  const ids = await importMemoriesAtomically(drafts)
  return { imported: ids.length, ids }
}
