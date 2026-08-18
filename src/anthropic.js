'use strict'

/**
 * Anthropic Messages API surface for the Freebuff proxy.
 *
 * Converts Anthropic requests (/v1/messages) to the OpenAI chat-completions
 * shape the daemon forwards upstream, then converts the response back —
 * including the Anthropic SSE event sequence and tool_use blocks. The upstream
 * call itself goes through daemon.proxyChat, so session admission, metadata
 * injection (freebuff_instance_id) and gate re-admission behave identically to
 * /v1/chat/completions.
 */

const rand = () => Math.random().toString(36).slice(2, 10)

function anthropicModelToOpenAI(model) {
  return String(model || '').replace(/^anthropic\//, '')
}

function textFromContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
  }
  return ''
}

/** Anthropic content blocks → OpenAI content parts (text + images). */
function contentPartsToOpenAI(content) {
  if (!Array.isArray(content)) return []
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image' && block.source) {
      const src = block.source
      if (src.type === 'base64' && src.media_type && src.data) {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${src.media_type};base64,${src.data}` },
        })
      } else if (src.type === 'url' && src.url) {
        parts.push({ type: 'image_url', image_url: { url: src.url } })
      }
    }
  }
  return parts
}

/**
 * Anthropic request → OpenAI chat-completions body.
 * `resolveModel` maps the requested model to a Freebuff slug (server-owned).
 */
function anthropicToOpenAI(body, opts = {}) {
  const oai = {}
  const requested = anthropicModelToOpenAI(body.model)
  oai.model = opts.resolveModel ? opts.resolveModel(requested) : requested

  const messages = []
  if (body.system) {
    const text =
      typeof body.system === 'string'
        ? body.system
        : textFromContent(body.system)
    if (text) messages.push({ role: 'system', content: text })
  }
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (!m || typeof m !== 'object') continue
    const content = m.content

    if (m.role === 'user') {
      // tool_result blocks become separate OpenAI `tool` messages.
      const results = Array.isArray(content)
        ? content.filter((b) => b && b.type === 'tool_result')
        : []
      if (results.length) {
        for (const r of results) {
          messages.push({
            role: 'tool',
            tool_call_id: r.tool_use_id || `call_${rand()}`,
            content:
              typeof r.content === 'string'
                ? r.content
                : textFromContent(r.content),
          })
        }
        continue
      }
      const parts = contentPartsToOpenAI(content)
      messages.push({
        role: 'user',
        content: parts.length ? parts : textFromContent(content) || '',
      })
    } else if (m.role === 'assistant') {
      const uses = Array.isArray(content)
        ? content.filter((b) => b && b.type === 'tool_use')
        : []
      if (uses.length) {
        messages.push({
          role: 'assistant',
          content:
            Array.isArray(content)
              ? content.filter((b) => b && b.type === 'text').map((b) => b.text).join('')
              : typeof content === 'string' ? content : '',
          tool_calls: uses.map((u) => ({
            id: u.id || `call_${rand()}`,
            type: 'function',
            function: {
              name: u.name || '',
              arguments: JSON.stringify(u.input ?? {}),
            },
          })),
        })
      } else {
        messages.push({
          role: 'assistant',
          content: typeof content === 'string' ? content : textFromContent(content),
        })
      }
    }
  }

  if (body.max_tokens !== undefined) oai.max_tokens = body.max_tokens
  if (body.temperature !== undefined) oai.temperature = body.temperature
  if (body.top_p !== undefined) oai.top_p = body.top_p
  if (body.top_k !== undefined) oai.top_k = body.top_k
  if (body.stop_sequences !== undefined) oai.stop = body.stop_sequences
  if (body.stream !== undefined) oai.stream = body.stream
  if (body.metadata && typeof body.metadata === 'object') oai.metadata = body.metadata

  if (Array.isArray(body.tools) && body.tools.length) {
    oai.tools = body.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema || {},
      },
    }))
  }
  if (body.tool_choice) {
    if (body.tool_choice === 'auto') oai.tool_choice = 'auto'
    else if (body.tool_choice === 'any') oai.tool_choice = 'required'
    else if (body.tool_choice && body.tool_choice.type === 'tool') {
      oai.tool_choice = {
        type: 'function',
        function: { name: body.tool_choice.name },
      }
    }
  }

  oai.messages = messages
  return oai
}

function safeParseArguments(raw) {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function anthropicStopReason(finishReason) {
  if (finishReason === 'tool_calls') return 'tool_use'
  if (finishReason === 'length') return 'max_tokens'
  if (finishReason === 'content_filter') return 'refusal'
  if (finishReason === 'stop' || finishReason === 'end_turn') return 'end_turn'
  return finishReason || 'end_turn'
}

/** OpenAI non-stream JSON → Anthropic message. */
function openaiToAnthropicResponse(oai, model) {
  const choice = oai?.choices?.[0]
  const msg = choice?.message || {}
  const content = []
  if (msg.content) content.push({ type: 'text', text: String(msg.content) })
  for (const tc of msg.tool_calls || []) {
    content.push({
      type: 'tool_use',
      id: tc.id || `toolu_${rand()}`,
      name: tc.function?.name || '',
      input: safeParseArguments(tc.function?.arguments),
    })
  }
  const usage = oai?.usage || {}
  return {
    id: oai?.id || `msg_${rand()}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: anthropicStopReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
    },
  }
}

function anthropicErrorBody(status, type, message) {
  return {
    type: 'error',
    error: {
      type,
      message,
    },
  }
}

/**
 * TransformStream: OpenAI chat-completions SSE → Anthropic Messages SSE
 * (message_start / content_block_* / message_delta / message_stop), including
 * tool_use blocks with input_json_delta events.
 */
function createAnthropicStream({ model, id, inputTokens, onDone }) {
  const encoder = new TextEncoder()
  let buf = ''
  let sentStart = false
  let contentIndex = -1
  let openTextBlock = null // content index of the open text block
  const openToolBlocks = new Map() // openai tool index -> anthropic block index
  let closed = false
  let stopReason = 'end_turn'
  let outputTokens = 0

  const send = (controller, event, data) => {
    controller.enqueue(
      encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    )
  }

  const ensureStart = (controller) => {
    if (sentStart) return
    sentStart = true
    send(controller, 'message_start', {
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    })
  }

  const closeAll = (controller) => {
    if (openTextBlock !== null) {
      send(controller, 'content_block_stop', {
        type: 'content_block_stop',
        index: openTextBlock,
      })
      openTextBlock = null
    }
    for (const [, blockIndex] of openToolBlocks) {
      send(controller, 'content_block_stop', {
        type: 'content_block_stop',
        index: blockIndex,
      })
    }
    openToolBlocks.clear()
    if (!closed) {
      closed = true
      send(controller, 'message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens },
      })
      send(controller, 'message_stop', { type: 'message_stop' })
      onDone?.({ stopReason, outputTokens })
    }
  }

  const handleChunk = (controller, parsed) => {
    ensureStart(controller)
    if (parsed.usage) {
      if (typeof parsed.usage.completion_tokens === 'number') {
        outputTokens = parsed.usage.completion_tokens
      } else if (typeof parsed.usage.total_tokens === 'number') {
        outputTokens = Math.max(0, parsed.usage.total_tokens - inputTokens)
      }
    }
    const choice = parsed.choices?.[0]
    if (!choice) return
    const delta = choice.delta || {}

    if (delta.content) {
      if (openTextBlock === null && openToolBlocks.size === 0) {
        contentIndex += 1
        openTextBlock = contentIndex
        send(controller, 'content_block_start', {
          type: 'content_block_start',
          index: contentIndex,
          content_block: { type: 'text', text: '' },
        })
      }
      if (openTextBlock !== null) {
        send(controller, 'content_block_delta', {
          type: 'content_block_delta',
          index: openTextBlock,
          delta: { type: 'text_delta', text: delta.content },
        })
      }
    }

    for (const tc of delta.tool_calls || []) {
      const idx = tc.index ?? 0
      let blockIndex = openToolBlocks.get(idx)
      if (blockIndex === undefined) {
        contentIndex += 1
        blockIndex = contentIndex
        openToolBlocks.set(idx, blockIndex)
        send(controller, 'content_block_start', {
          type: 'content_block_start',
          index: blockIndex,
          content_block: {
            type: 'tool_use',
            id: tc.id || `toolu_${rand()}`,
            name: tc.function?.name || '',
            input: {},
          },
        })
      }
      const partial = tc.function?.arguments
      if (partial) {
        send(controller, 'content_block_delta', {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'input_json_delta', partial_json: partial },
        })
      }
    }

    if (choice.finish_reason) {
      stopReason = anthropicStopReason(choice.finish_reason)
      closeAll(controller)
    }
  }

  return new TransformStream({
    transform(chunk, controller) {
      buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        try {
          handleChunk(controller, JSON.parse(payload))
        } catch {
          /* ignore malformed frames */
        }
      }
    },
    flush(controller) {
      if (!closed) {
        stopReason = stopReason || 'end_turn'
        closeAll(controller)
      }
    },
  })
}

// ---- token estimation (count_tokens) -------------------------------------

function estimateChars(value) {
  if (typeof value === 'string') return value.length
  if (Array.isArray(value)) {
    return value.reduce((n, x) => n + estimateChars(x), 0)
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).reduce(
      (n, [k, v]) => n + k.length + estimateChars(v),
      0,
    )
  }
  return 0
}

/** Rough token estimate: ~4 chars per token, like the reference proxy. */
function countAnthropicTokens(body) {
  const oai = anthropicToOpenAI(body, {})
  const chars =
    estimateChars(oai.messages) +
    estimateChars(oai.tools) +
    (oai.metadata ? estimateChars(oai.metadata) : 0)
  return Math.max(1, Math.ceil(chars / 4))
}

module.exports = {
  anthropicToOpenAI,
  openaiToAnthropicResponse,
  anthropicStopReason,
  createAnthropicStream,
  anthropicModelToOpenAI,
  countAnthropicTokens,
  anthropicErrorBody,
}
