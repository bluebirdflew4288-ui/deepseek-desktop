(() => {
  const SOURCE = 'deepseek-desktop-memory'
  const REQUEST = 'DPP_MEMORY_REQUEST'
  const RESPONSE = 'DPP_MEMORY_RESPONSE'
  const BRIDGE_READY = 'DPP_MEMORY_BRIDGE_READY'
  const BRIDGE_HELLO = 'DPP_MEMORY_BRIDGE_HELLO'
  const BRIDGE_ACK = 'DPP_MEMORY_BRIDGE_ACK'
  const COMPLETION_AUTH = 'DPP_MEMORY_COMPLETION_AUTH'
  const AUTH_GRACE_MS = 60_000
  const MAX_RENDERED_TEXT_LENGTH = 2_000_000
  const MAX_RENDERED_SAVE_ATTEMPTS = 3
  const RENDERED_SAVE_RETRY_DELAY_MS = 1_000
  // The nonce prevents accidental cross-talk between page messages and this extension bridge.
  // It does not turn a compromised same-origin Chat page into an untrusted process boundary.
  let nonce
  const renderedSaveCalls = new Set()
  const pendingSaveCalls = new Set()
  const dirtyMessages = new Set()
  let scanTimer
  let completionAuth

  function isOwnMessage(event, type) {
    return event.source === window
      && event.origin === location.origin
      && event.data?.source === SOURCE
      && event.data?.type === type
  }

  function sendRuntime(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, result => {
        const lastError = chrome.runtime.lastError
        if (lastError) reject(new Error(lastError.message))
        else if (!result?.ok) reject(new Error(result?.error ?? 'Memory host returned no result'))
        else resolve(result.value)
      })
    })
  }

  // Three-state authorship: unknown messages may always be hidden, but save only as the latest message under a live completion authorization.
  function messageAuthorship(message) {
    if (!(message instanceof Element) || !message.matches('div.ds-message')) return undefined
    const role = message.getAttribute('data-message-author-role')?.toLowerCase()
    if (role === 'assistant' || role === 'user') return role
    if (message.classList.contains('d29f3d7d') || message.closest('div._9663006')) return 'user'
    return 'unknown'
  }

  function renderedMarkdownContainers(message) {
    return [...message.querySelectorAll('.ds-markdown')].filter(container => (
      container.closest('div.ds-message') === message
      && !container.closest('.ds-think-content, [class*="think"]')
    ))
  }

  function memorySaveRanges(text) {
    const ranges = []
    const pattern = /<memory_save>[\s\S]*?<\/memory_save>/giu
    let match
    while ((match = pattern.exec(text)) !== null) {
      ranges.push({ start: match.index, end: match.index + match[0].length, text: match[0] })
    }
    return ranges
  }

  function claimRenderedSave(call) {
    if (renderedSaveCalls.has(call) || pendingSaveCalls.has(call)) return false
    pendingSaveCalls.add(call)
    return true
  }

  // Only an accepted delivery fingerprints a call; a dropped claim lets a later
  // re-render of the same assistant message deliver it again.
  function settleRenderedSaves(calls, saved) {
    for (const call of calls) {
      pendingSaveCalls.delete(call)
      if (!saved) continue
      renderedSaveCalls.add(call)
      if (renderedSaveCalls.size > 256) renderedSaveCalls.delete(renderedSaveCalls.values().next().value)
    }
  }

  // The authorization is the network layer's proof that the latest rendered
  // response belongs to a real in-flight assistant completion. It is short-lived
  // and consumed by exactly one successful save, so historical messages never save.
  function liveCompletionAuthorization() {
    if (!completionAuth || completionAuth.consumed || Date.now() >= completionAuth.validUntil) return undefined
    return completionAuth
  }

  function deliverRenderedCalls(calls, attempt, auth) {
    void sendRuntime({ type: 'MEMORY_AUTO_SAVE', payload: { text: calls.join('\n') } }).then(
      () => {
        settleRenderedSaves(calls, true)
        if (auth) auth.consumed = true
      },
      error => {
        console.warn('[DeepSeek Desktop Memory] rendered response fallback failed without affecting Chat', error)
        if (attempt >= MAX_RENDERED_SAVE_ATTEMPTS) {
          settleRenderedSaves(calls, false)
          return
        }
        window.setTimeout(() => deliverRenderedCalls(calls, attempt + 1, auth), RENDERED_SAVE_RETRY_DELAY_MS)
      },
    )
  }

  function saveRenderedCalls(calls, auth) {
    if (auth?.consumed) return
    const unseen = []
    let length = 0
    for (const call of calls) {
      if (call.length > MAX_RENDERED_TEXT_LENGTH) continue
      const nextLength = length + (unseen.length === 0 ? 0 : 1) + call.length
      if (nextLength > MAX_RENDERED_TEXT_LENGTH || !claimRenderedSave(call)) continue
      unseen.push(call)
      length = nextLength
    }
    if (unseen.length === 0) return
    deliverRenderedCalls(unseen, 1, auth)
  }

  function stripTextRanges(container, ranges) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
    const nodes = []
    let offset = 0
    while (walker.nextNode()) {
      const node = walker.currentNode
      const text = node.textContent ?? ''
      nodes.push({ node, start: offset, end: offset + text.length, text })
      offset += text.length
    }
    for (const entry of nodes) {
      const localRanges = ranges
        .map(range => ({ start: Math.max(0, range.start - entry.start), end: Math.min(entry.text.length, range.end - entry.start) }))
        .filter(range => range.start < range.end)
        .sort((left, right) => right.start - left.start)
      let text = entry.text
      for (const range of localRanges) text = text.slice(0, range.start) + text.slice(range.end)
      if (text !== entry.text) entry.node.textContent = text
    }
  }

  function processMarkdown(container, save, auth) {
    if ((container.textContent?.length ?? 0) > MAX_RENDERED_TEXT_LENGTH) return
    const calls = []
    for (const element of container.querySelectorAll('memory_save')) {
      calls.push(`<memory_save>${element.textContent ?? ''}</memory_save>`)
      // Hiding without detaching leaves the node owned by the page renderer, which
      // still holds a reference to it; removing it can make a later update throw.
      element.style.display = 'none'
    }
    const text = container.textContent ?? ''
    const ranges = memorySaveRanges(text)
    calls.push(...ranges.map(range => range.text))
    if (save) saveRenderedCalls(calls, auth)
    if (ranges.length > 0) stripTextRanges(container, ranges)
  }

  function scanRenderedMessages() {
    scanTimer = undefined
    const auth = liveCompletionAuthorization()
    const messages = [...document.querySelectorAll('div.ds-message')]
    const latest = messages.findLast(message => renderedMarkdownContainers(message).length > 0)
    const targets = dirtyMessages.size === 0 ? messages : [...dirtyMessages]
    dirtyMessages.clear()
    for (const message of targets) {
      if (!message.isConnected) continue
      const authorship = messageAuthorship(message)
      if (authorship === undefined || authorship === 'user') continue
      const save = auth !== undefined && message === latest
      for (const container of renderedMarkdownContainers(message)) {
        processMarkdown(container, save, auth)
      }
    }
  }

  function scheduleRenderedScan(message) {
    if (message !== undefined) dirtyMessages.add(message)
    if (scanTimer !== undefined) return
    scanTimer = window.setTimeout(scanRenderedMessages, 60)
  }

  function queueMessageNodes(node) {
    const element = node instanceof Element ? node : node.parentElement
    if (!element) return
    const owner = element.closest('div.ds-message')
    if (owner) scheduleRenderedScan(owner)
    if (element.matches('div.ds-message')) scheduleRenderedScan(element)
    for (const message of element.querySelectorAll('div.ds-message')) scheduleRenderedScan(message)
  }

  function observeRenderedMessages() {
    if (!document.body) return false
    for (const message of document.querySelectorAll('div.ds-message')) scheduleRenderedScan(message)
    new MutationObserver(mutations => {
      for (const mutation of mutations) {
        queueMessageNodes(mutation.target)
        for (const node of mutation.addedNodes) queueMessageNodes(node)
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true })
    return true
  }

  if (!observeRenderedMessages()) {
    const bodyObserver = new MutationObserver(() => {
      if (!observeRenderedMessages()) return
      bodyObserver.disconnect()
    })
    bodyObserver.observe(document.documentElement, { childList: true, subtree: true })
  }

  window.addEventListener('message', event => {
    if (isOwnMessage(event, BRIDGE_HELLO) && typeof event.data.nonce === 'string' && /^[a-f0-9]{32}$/u.test(event.data.nonce)) {
      nonce = event.data.nonce
      window.postMessage({ source: SOURCE, type: BRIDGE_ACK, nonce }, location.origin)
      return
    }
    if (isOwnMessage(event, COMPLETION_AUTH) && event.data.nonce === nonce && typeof event.data.id === 'string') {
      const previous = completionAuth
      completionAuth = previous && previous.id === event.data.id
        ? { ...previous, validUntil: Date.now() + AUTH_GRACE_MS }
        : { id: event.data.id, validUntil: Date.now() + AUTH_GRACE_MS, consumed: false }
      scheduleRenderedScan()
      return
    }
    if (!isOwnMessage(event, REQUEST) || event.data.nonce !== nonce) return
    const message = event.data
    if (typeof message.id !== 'string' || !/^\d+-\d+$/u.test(message.id)) return
    const request = message.kind === 'augment' && typeof message.prompt === 'string' && message.prompt.length <= 200_000
      ? { type: 'AUGMENT_PROMPT', payload: { prompt: message.prompt } }
      : message.kind === 'automatic-save' && typeof message.text === 'string' && message.text.length <= 2_000_000
        ? { type: 'MEMORY_AUTO_SAVE', payload: { text: message.text } }
            : undefined
    if (!request) return
    sendRuntime(request).then(
      value => {
        window.postMessage({ source: SOURCE, type: RESPONSE, nonce, id: message.id, ok: true, value }, location.origin)
      },
      error => {
        window.postMessage({ source: SOURCE, type: RESPONSE, nonce, id: message.id, ok: false, error: error.message }, location.origin)
      },
    )
  })

  window.postMessage({ source: SOURCE, type: BRIDGE_READY }, location.origin)
})()
