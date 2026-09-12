(() => {
  const SOURCE = 'deepseek-desktop-memory'
  const REQUEST = 'DPP_MEMORY_REQUEST'
  const RESPONSE = 'DPP_MEMORY_RESPONSE'
  const BRIDGE_READY = 'DPP_MEMORY_BRIDGE_READY'
  const BRIDGE_HELLO = 'DPP_MEMORY_BRIDGE_HELLO'
  const BRIDGE_ACK = 'DPP_MEMORY_BRIDGE_ACK'
  const COMPLETION_ORIGIN = 'https://chat.deepseek.com'
  const COMPLETION_PATH = '/api/v0/chat/completion'
  const COMPLETION_AUTH = 'DPP_MEMORY_COMPLETION_AUTH'
  const FETCH_MARKER = Symbol.for('deepseek-desktop-memory.fetch-installed')
  const XHR_MARKER = Symbol.for('deepseek-desktop-memory.xhr-installed')
  // This capability nonce filters unrelated same-origin messages. The Chat origin remains a trusted page boundary;
  // a compromised page script can still observe the in-page hook and is not made privileged by this bridge.
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
  let sequence = 0
  let completionAuthSequence = 0
  let bridgeReady
  let resolveBridgeReady

  function isOwnMessage(event, type) {
    return event.source === window
      && event.origin === location.origin
      && event.data?.source === SOURCE
      && event.data?.type === type
  }

  bridgeReady = new Promise(resolve => { resolveBridgeReady = resolve })
  window.addEventListener('message', event => {
    if (isOwnMessage(event, BRIDGE_ACK) && event.data.nonce === nonce) resolveBridgeReady()
    if (isOwnMessage(event, BRIDGE_READY)) {
      window.postMessage({ source: SOURCE, type: BRIDGE_HELLO, nonce }, location.origin)
    }
  })
  window.postMessage({ source: SOURCE, type: BRIDGE_HELLO, nonce }, location.origin)

  // The rendered fallback may write Memory only while this hook proves a live assistant completion: the grant is minted on first streamed assistant text, refreshed per chunk, and expires shortly after the stream goes quiet.
  function postCompletionAuth(id) {
    window.postMessage({ source: SOURCE, type: COMPLETION_AUTH, nonce, id }, location.origin)
  }

  async function bridge(kind, payload, timeout = 3000) {
    await Promise.race([
      bridgeReady,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Memory bridge unavailable')), timeout)),
    ])
    const id = `${Date.now()}-${++sequence}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        window.removeEventListener('message', receive)
        reject(new Error('Memory bridge timed out'))
      }, timeout)
      function receive(event) {
        const message = event.data
        if (!isOwnMessage(event, RESPONSE) || message.nonce !== nonce || message.id !== id) return
        clearTimeout(timer)
        window.removeEventListener('message', receive)
        if (message.ok) resolve(message.value)
        else reject(new Error(message.error ?? 'Memory bridge failed'))
      }
      window.addEventListener('message', receive)
      window.postMessage({ source: SOURCE, type: REQUEST, nonce, id, kind, ...payload }, location.origin)
    })
  }

  function isCompletionUrl(value) {
    try {
      const url = new URL(String(value), location.href)
      return url.origin === COMPLETION_ORIGIN && url.pathname === COMPLETION_PATH
    } catch { return false }
  }

  async function augmentedBody(body) {
    if (typeof body !== 'string') return body
    let value
    try { value = JSON.parse(body) } catch { return body }
    if (!value || typeof value !== 'object' || typeof value.prompt !== 'string') return body
    if (value.parent_message_id !== null && value.parent_message_id !== undefined) return body
    try {
      const result = await bridge('augment', { prompt: value.prompt })
      if (!result || typeof result.prompt !== 'string') return body
      return JSON.stringify({ ...value, prompt: result.prompt })
    } catch (error) {
      console.warn('[DeepSeek Desktop Memory] prompt augmentation failed; sending the original request', error)
      return body
    }
  }

  function textFromValue(value, output) {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) textFromValue(item, output)
      return
    }
    if (typeof value.delta?.content === 'string') output.push(value.delta.content)
    if (typeof value.content === 'string' && (value.type === 'text' || value.role === 'assistant')) output.push(value.content)
    if (typeof value.text === 'string') output.push(value.text)
    if (typeof value.v === 'string' && (typeof value.p !== 'string' || value.p === '' || value.p.startsWith('response'))) output.push(value.v)
    if (Array.isArray(value.v) && (value.o === 'BATCH' || String(value.p ?? '').startsWith('response'))) {
      for (const item of value.v) textFromValue(item, output)
    }
  }

  function joinedPath(left, right) {
    return [left, right].filter(Boolean).join('/').replace(/\/{2,}/gu, '/')
  }

  function flattenDelta(value, basePath, output) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const path = typeof value.p === 'string' ? value.p : ''
    const op = typeof value.o === 'string' ? value.o : 'SET'
    if (op !== 'BATCH' || !Array.isArray(value.v)) {
      output.push({ op, path: joinedPath(basePath, path), value: value.v })
      return
    }

    // DeepSeek batches carry a common parent path. Child deltas inherit the
    // previous child operation/path exactly as the official web client does.
    let childOp = 'SET'
    let childPath = ''
    const batchPath = joinedPath(basePath, path)
    for (const child of value.v) {
      if (!child || typeof child !== 'object' || Array.isArray(child)) continue
      if (typeof child.o === 'string') childOp = child.o
      if (typeof child.p === 'string') childPath = child.p
      if (childOp === 'BATCH') {
        flattenDelta({ ...child, o: childOp, p: childPath }, batchPath, output)
      } else {
        output.push({ op: childOp, path: joinedPath(batchPath, childPath), value: child.v })
      }
    }
  }

  function applyResponseDelta(fragments, delta) {
    const segments = delta.path.split('/').filter(Boolean)
    if (segments.length === 0) {
      const snapshot = delta.value?.response?.fragments
      if (delta.op === 'SET' && Array.isArray(snapshot)) fragments.splice(0, fragments.length, ...snapshot)
      return
    }
    const responseIndex = segments.indexOf('response')
    if (responseIndex < 0 || segments[responseIndex + 1] !== 'fragments') return
    const remainder = segments.slice(responseIndex + 2)
    if (remainder.length === 0) {
      const values = Array.isArray(delta.value) ? delta.value : [delta.value]
      const records = values.filter(value => value && typeof value === 'object' && !Array.isArray(value))
      if (delta.op === 'SET') fragments.splice(0, fragments.length, ...records)
      else if (delta.op === 'APPEND') fragments.push(...records)
      return
    }
    const index = Number(remainder[0])
    if (!Number.isSafeInteger(index) || index < 0) return
    while (fragments.length <= index) fragments.push({})
    if (remainder.length === 1 && delta.value && typeof delta.value === 'object' && !Array.isArray(delta.value)) {
      fragments[index] = delta.op === 'APPEND' ? { ...fragments[index], ...delta.value } : delta.value
      return
    }
    const field = remainder[1]
    if (field !== 'type' && field !== 'content') return
    if (typeof delta.value !== 'string') return
    if (delta.op === 'APPEND' && typeof fragments[index][field] === 'string') fragments[index][field] += delta.value
    else fragments[index][field] = delta.value
  }

  function assistantText(raw) {
    const fallback = []
    const fragments = []
    for (const line of raw.split(/\r?\n/)) {
      const payload = line.startsWith('data:') ? line.slice(5).trim() : line.trim()
      if (!payload || payload === '[DONE]') continue
      try {
        const value = JSON.parse(payload)
        const deltas = []
        flattenDelta(value, '', deltas)
        for (const delta of deltas) applyResponseDelta(fragments, delta)
        textFromValue(value, fallback)
      } catch { /* non-JSON stream fields carry no assistant text */ }
    }
    const response = fragments
      .filter(fragment => fragment?.type === 'RESPONSE' || fragment?.type === 'TEMPLATE_RESPONSE')
      .map(fragment => typeof fragment.content === 'string' ? fragment.content : '')
      .join('')
    if (response) return response
    if (fallback.length === 0) {
      try { textFromValue(JSON.parse(raw), fallback) } catch { /* unsupported response format is ignored */ }
    }
    return fallback.join('')
  }

  async function captureAutomaticMemory(raw) {
    const text = assistantText(raw)
    if (!/<memory_save>/iu.test(text)) return
    await bridge('automatic-save', { text }, 5000).catch(error => {
      console.warn('[DeepSeek Desktop Memory] automatic save failed without affecting Chat', error)
    })
  }

  async function consumeAutomaticMemory(response, authId) {
    let clone
    try { clone = response.clone() } catch { return }
    if (!clone.body) {
      try { await captureAutomaticMemory(await clone.text()) } catch { /* response inspection is best-effort */ }
      return
    }
    const reader = clone.body.getReader()
    const decoder = new TextDecoder()
    let raw = ''
    let capturedClosings = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        raw += decoder.decode(value, { stream: true })
        if (raw.length > 2_000_000) {
          await reader.cancel().catch(() => undefined)
          return
        }
        const text = assistantText(raw)
        if (text) postCompletionAuth(authId)
        const closings = text.match(/<\/memory_save>/giu)?.length ?? 0
        if (closings > capturedClosings) {
          await captureAutomaticMemory(raw)
          capturedClosings = closings
        }
      }
      raw += decoder.decode()
    } catch { /* DeepSeek may abort the SSE transport after its finish event */ }
    const closings = assistantText(raw).match(/<\/memory_save>/giu)?.length ?? 0
    if (closings > capturedClosings) await captureAutomaticMemory(raw)
  }

  if (!window.fetch[FETCH_MARKER]) {
    const originalFetch = window.fetch
    const hookedFetch = async function(input, init) {
      const url = input instanceof Request ? input.url : input
      if (!isCompletionUrl(url)) return originalFetch.apply(this, arguments)
      let nextInput = input
      let nextInit = init
      try {
        if (input instanceof Request && init?.body === undefined) {
          const body = await input.clone().text()
          nextInput = new Request(input, { body: await augmentedBody(body) })
        } else if (init?.body !== undefined) {
          nextInit = { ...init, body: await augmentedBody(init.body) }
        }
      } catch (error) {
        // Request cloning/construction is best-effort: a site-side body format or
        // streaming request must never make Chat unavailable just because Memory
        // could not inspect it.
        console.warn('[DeepSeek Desktop Memory] request augmentation failed; sending the original request', error)
        nextInput = input
        nextInit = init
      }
      const authId = `${Date.now()}-${++completionAuthSequence}`
      postCompletionAuth(authId)
      const response = await originalFetch.call(this, nextInput, nextInit)
      void consumeAutomaticMemory(response, authId)
      return response
    }
    hookedFetch[FETCH_MARKER] = true
    window.fetch = hookedFetch
  }

  if (!XMLHttpRequest.prototype[XHR_MARKER]) {
    const originalOpen = XMLHttpRequest.prototype.open
    const originalSend = XMLHttpRequest.prototype.send
    XMLHttpRequest.prototype.open = function(method, url) {
      this.__deepseekMemoryUrl = url
      return originalOpen.apply(this, arguments)
    }
    XMLHttpRequest.prototype.send = function(body) {
      if (!isCompletionUrl(this.__deepseekMemoryUrl)) return originalSend.call(this, body)
      const request = this
      void augmentedBody(body).then(nextBody => {
        const authId = `${Date.now()}-${++completionAuthSequence}`
        postCompletionAuth(authId)
        let capturedClosings = 0
        let captureQueue = Promise.resolve()
        const inspectResponse = () => {
          let raw
          try { raw = request.responseText } catch { return }
          if (typeof raw !== 'string' || raw.length > 2_000_000) return
          postCompletionAuth(authId)
          const text = assistantText(raw)
          const closings = text.match(/<\/memory_save>/giu)?.length ?? 0
          if (closings <= capturedClosings) return
          capturedClosings = closings
          captureQueue = captureQueue.then(() => captureAutomaticMemory(raw))
        }
        request.addEventListener('progress', inspectResponse)
        request.addEventListener('readystatechange', inspectResponse)
        request.addEventListener('load', inspectResponse)
        request.addEventListener('loadend', inspectResponse)
        originalSend.call(request, nextBody)
      }).catch(() => {
        originalSend.call(request, body)
      })
    }
    XMLHttpRequest.prototype[XHR_MARKER] = true
  }

})()
