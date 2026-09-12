const labels = { user: '用户', feedback: '纠正', topic: '主题', reference: '参考' }
let memories = []

const element = id => {
  const value = document.getElementById(id)
  if (!value) throw new Error(`Missing Memory manager element: ${id}`)
  return value
}

function request(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, result => {
      const lastError = chrome.runtime.lastError
      if (lastError) reject(new Error(lastError.message))
      else if (!result?.ok) reject(new Error(result?.error ?? 'Memory operation failed'))
      else resolve(result.value)
    })
  })
}

function notice(message, error = false) {
  const target = element('notice')
  target.textContent = message
  target.dataset.error = String(error)
}

function visibleMemories() {
  const query = element('search').value.trim().toLowerCase()
  const type = element('filter').value
  return memories.filter(memory => {
    if (type !== 'all' && memory.type !== type) return false
    if (!query) return true
    return [memory.name, memory.content, ...memory.tags].some(value => value.toLowerCase().includes(query))
  })
}

function render() {
  const list = element('list')
  list.replaceChildren()
  const visible = visibleMemories()
  element('summary').textContent = `${memories.length} 条本地记忆 · 数据仅保存在此设备`
  element('empty').hidden = visible.length !== 0
  const template = element('card-template')
  for (const memory of visible) {
    const card = template.content.firstElementChild.cloneNode(true)
    card.querySelector('.badge').textContent = labels[memory.type] ?? memory.type
    card.querySelector('h2').textContent = memory.name
    card.querySelector('.content').textContent = memory.content
    card.querySelector('time').textContent = new Date(memory.updatedAt).toLocaleString()
    const tags = card.querySelector('.tags')
    for (const tag of memory.tags) {
      const item = document.createElement('span')
      item.className = 'tag'
      item.textContent = tag
      tags.append(item)
    }
    const pin = card.querySelector('.pin')
    pin.textContent = memory.pinned ? '★' : '☆'
    pin.dataset.pinned = String(memory.pinned)
    pin.addEventListener('click', () => update({ ...memory, pinned: !memory.pinned }))
    card.querySelector('.edit').addEventListener('click', () => edit(memory))
    card.querySelector('.delete').addEventListener('click', () => remove(memory))
    list.append(card)
  }
}

async function load() {
  try {
    memories = await request({ type: 'GET_MEMORIES' })
    render()
    notice('')
  } catch (error) {
    notice(error.message, true)
  }
}

function edit(memory) {
  element('memory-id').value = memory?.id ?? ''
  element('type').value = memory?.type ?? 'user'
  element('name').value = memory?.name ?? ''
  element('content').value = memory?.content ?? ''
  element('tags').value = memory?.tags?.join(', ') ?? ''
  element('editor').hidden = false
  element('name').focus()
}

function closeEditor() {
  element('form').reset()
  element('memory-id').value = ''
  element('editor').hidden = true
}

async function update(memory) {
  try {
    await request({ type: 'UPDATE_MEMORY', payload: memory })
    await load()
  } catch (error) {
    notice(error.message, true)
  }
}

async function remove(memory) {
  if (!confirm(`删除“${memory.name}”？此操作无法撤销。`)) return
  try {
    await request({ type: 'DELETE_MEMORY', payload: { id: memory.id } })
    await load()
  } catch (error) {
    notice(error.message, true)
  }
}

element('form').addEventListener('submit', async event => {
  event.preventDefault()
  const id = Number(element('memory-id').value)
  const draft = {
    type: element('type').value,
    name: element('name').value.trim(),
    content: element('content').value.trim(),
    description: element('name').value.trim(),
    tags: element('tags').value.split(/[,，]/).map(tag => tag.trim()).filter(Boolean),
    pinned: id ? memories.find(memory => memory.id === id)?.pinned === true : false,
  }
  try {
    if (id) {
      const current = memories.find(memory => memory.id === id)
      if (!current) throw new Error('要编辑的记忆已不存在')
      await request({ type: 'UPDATE_MEMORY', payload: { ...current, ...draft } })
    } else {
      await request({ type: 'SAVE_MEMORY', payload: draft })
    }
    closeEditor()
    await load()
  } catch (error) {
    notice(error.message, true)
  }
})

element('add').addEventListener('click', () => edit())
element('cancel').addEventListener('click', closeEditor)
element('search').addEventListener('input', render)
element('filter').addEventListener('change', render)
element('export').addEventListener('click', () => window.open('dsh-memory-action://export'))
element('import').addEventListener('click', () => window.open('dsh-memory-action://import'))
window.addEventListener('focus', () => { void load() })
chrome.runtime.onMessage.addListener(message => {
  if (message?.type === 'MEMORY_STATE_UPDATED') void load()
})

await load()
