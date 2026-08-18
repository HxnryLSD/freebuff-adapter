'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const http = require('node:http')

const { FreebuffClient } = require('../src/freebuff')
const { Bus } = require('../src/bus')
const { Daemon } = require('../src/daemon')
const { MODELS } = require('../src/models')
const { INJECTED_SYSTEM_PROMPT } = require('../src/freebuff-prompt')

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve(null)
      }
    })
  })
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function startStub(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  }
}

const MODEL = MODELS[0].id // deepseek/deepseek-v4-pro

/**
 * Stub Freebuff upstream that records session + chat traffic and can reject
 * the first chat call with a configurable gate (or pass it through).
 */
async function makeStub({ gate = null, secondPostStatus = null, chatStatus = 200 } = {}) {
  const calls = {
    sessionPosts: 0,
    sessionGets: 0,
    sessionDeletes: 0,
    chatCalls: 0,
    chatBodies: [],
    sessionModels: [],
    instanceIds: new Map(),
  }
  const { server, baseUrl } = await startStub(async (req, res) => {
    const url = new URL(req.url, baseUrl)

    if (url.pathname === '/api/v1/freebuff/session') {
      const token = (req.headers.authorization || '').replace(/^Bearer\s+/, '')
      if (req.method === 'POST') {
        calls.sessionPosts += 1
        calls.sessionModels.push(req.headers['x-freebuff-model'])
        // Use a non-retryable status for a failing re-admission so the
        // client's 429/5xx retry loop cannot mask it in the test.
        if (secondPostStatus && calls.sessionPosts === 2) {
          return sendJson(res, secondPostStatus, {})
        }
        const instanceId = `inst-${calls.sessionPosts}`
        calls.instanceIds.set(token, instanceId)
        return sendJson(res, 200, {
          status: 'active',
          instanceId,
          model: req.headers['x-freebuff-model'] || MODEL,
          admittedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          remainingMs: 3_600_000,
          rateLimit: { limit: 6, period: 'pacific_day', recentCount: 1 },
        })
      }
      if (req.method === 'DELETE') {
        calls.sessionDeletes += 1
        return sendJson(res, 200, {})
      }
      calls.sessionGets += 1
      const instanceId = calls.instanceIds.get(token)
      if (!instanceId) {
        res.writeHead(404)
        return res.end()
      }
      return sendJson(res, 200, {
        status: 'active',
        instanceId,
        model: MODEL,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        remainingMs: 3_600_000,
      })
    }

    if (url.pathname === '/api/v1/agent-runs') {
      // The chat gate requires a server-side run; hand out one per chat call.
      return sendJson(res, 200, { runId: `run-${calls.chatCalls + 1}` })
    }

    if (url.pathname === '/api/v1/chat/completions') {
      calls.chatCalls += 1
      const body = await readJsonBody(req)
      calls.chatBodies.push(body)
      if (gate && calls.chatCalls === 1) {
        res.writeHead(gate.status, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify(gate.body))
      }
      res.writeHead(chatStatus, { 'Content-Type': 'application/json' })
      return res.end(
        JSON.stringify({
          id: 'chatcmpl-1',
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }),
      )
    }

    res.writeHead(404)
    res.end()
  })
  return { server, baseUrl, calls }
}

function makeDaemon(baseUrl) {
  const bus = new Bus()
  const store = {
    settings: { model: MODEL },
    user: { id: 'u1', email: 'a@b.c', authToken: 'tok' },
  }
  const client = new FreebuffClient({ baseUrl, chatBaseUrl: baseUrl, bus })
  const daemon = new Daemon({ config: {}, bus, store, client })
  daemon._token = 'tok'
  daemon.session = null
  return daemon
}

const chatBody = {
  model: MODEL,
  messages: [{ role: 'user', content: 'hello' }],
}

for (const [name, gate] of [
  ['session_expired (410)', { status: 410, body: { error: 'session_expired' } }],
  ['waiting_room_required (428)', { status: 428, body: { error: 'waiting_room_required' } }],
  ['session_superseded (409)', { status: 409, body: { error: 'session_superseded' } }],
  ['session_model_mismatch (409)', { status: 409, body: { error: 'session_model_mismatch' } }],
]) {
  test(`proxyChat re-admits and retries on ${name}`, async () => {
    const { server, baseUrl, calls } = await makeStub({ gate })
    try {
      const daemon = makeDaemon(baseUrl)
      const { res, meta } = await daemon.proxyChat(chatBody)

      assert.equal(res.status, 200)
      assert.equal(meta.gateRetried, true)
      assert.ok(meta.gate, name.split(' ')[0])

      // initial admit + re-admit, one release, two chat calls
      assert.equal(calls.sessionPosts, 2)
      assert.equal(calls.sessionDeletes, 1)
      assert.equal(calls.chatCalls, 2)

      // the retried request carries the freshly admitted instance id
      const last = calls.chatBodies[calls.chatBodies.length - 1]
      const injected = last.providerOptions.codebuff.codebuff_metadata
      assert.equal(injected.freebuff_instance_id, 'inst-2')
      assert.equal(injected.cost_mode, 'free')
      assert.ok(injected.run_id)
      assert.ok(injected.client_id)
      // the newer contract: the gate reads top-level codebuff_metadata
      assert.equal(last.codebuff_metadata.freebuff_instance_id, 'inst-2')
      assert.equal(last.codebuff_metadata.run_id, 'run-2')
      assert.equal(last.codebuff_metadata.cost_mode, 'free')
    } finally {
      server.close()
    }
  })
}

test('proxyChat passes a non-gate 409 through without re-admitting', async () => {
  const { server, baseUrl, calls } = await makeStub({
    gate: { status: 409, body: { error: 'some_unrelated_conflict' } },
  })
  try {
    const daemon = makeDaemon(baseUrl)
    const { res, meta } = await daemon.proxyChat(chatBody)
    assert.equal(res.status, 409)
    assert.equal(meta.gateRetried, false)
    assert.equal(calls.sessionPosts, 1) // no re-admit
    assert.equal(calls.sessionDeletes, 0)
    assert.equal(calls.chatCalls, 1)
    // the upstream error body must reach the client byte-for-byte
    const text = await res.text()
    assert.equal(JSON.parse(text).error, 'some_unrelated_conflict')
  } finally {
    server.close()
  }
})

test('proxyChat passes a 403 free_mode_cli_required through and reports it', async () => {
  const { server, baseUrl, calls } = await makeStub({
    gate: { status: 403, body: { error: 'free_mode_cli_required' } },
  })
  try {
    const daemon = makeDaemon(baseUrl)
    const { res, meta } = await daemon.proxyChat(chatBody)
    assert.equal(res.status, 403)
    assert.equal(meta.gateRetried, false)
    const text = await res.text()
    assert.match(text, /free_mode_cli_required/)
    assert.equal(calls.sessionPosts, 1) // not a session gate: no re-admit
    assert.equal(
      daemon.bus.reports.some((r) => r.name === 'chat_cli_required'),
      true,
    )
  } finally {
    server.close()
  }
})

test('proxyChat passes a 429 (waiting_room_queued) through without re-admitting', async () => {
  const { server, baseUrl, calls } = await makeStub({
    gate: { status: 429, body: { error: 'waiting_room_queued' } },
  })
  try {
    const daemon = makeDaemon(baseUrl)
    const { res, meta } = await daemon.proxyChat(chatBody)
    assert.equal(res.status, 429)
    assert.equal(meta.gateRetried, false)
    assert.equal(calls.sessionPosts, 1)
    assert.equal(calls.sessionDeletes, 0)
  } finally {
    server.close()
  }
})

test('proxyChat succeeds on the first call when there is no gate', async () => {
  const { server, baseUrl, calls } = await makeStub()
  try {
    const daemon = makeDaemon(baseUrl)
    const { res, meta } = await daemon.proxyChat(chatBody)
    assert.equal(res.status, 200)
    assert.equal(meta.gateRetried, false)
    assert.equal(calls.sessionPosts, 1)
    assert.equal(calls.chatCalls, 1)
    const injected = calls.chatBodies[0].providerOptions.codebuff.codebuff_metadata
    assert.equal(injected.freebuff_instance_id, 'inst-1')
    assert.equal(calls.chatBodies[0].codebuff_metadata.run_id, 'run-1')
  } finally {
    server.close()
  }
})

test('proxyChat surfaces the gate error when re-admission fails', async () => {
  const { server, baseUrl, calls } = await makeStub({
    gate: { status: 410, body: { error: 'session_expired' } },
    secondPostStatus: 400,
  })
  try {
    const daemon = makeDaemon(baseUrl)
    const { res, meta } = await daemon.proxyChat(chatBody)
    assert.equal(res.status, 410)
    assert.equal(meta.gate, 'session_expired')
    const text = await res.text()
    assert.match(text, /session_expired/)
    assert.equal(calls.sessionPosts, 2) // re-admit was attempted
    assert.equal(calls.chatCalls, 1) // never retried
  } finally {
    server.close()
  }
})

test('proxyChat throws 401 when not logged in', async () => {
  const { server, baseUrl } = await makeStub()
  try {
    const daemon = makeDaemon(baseUrl)
    daemon._token = null
    await assert.rejects(
      daemon.proxyChat(chatBody),
      (err) => err.status === 401,
    )
  } finally {
    server.close()
  }
})

test('proxyChat rejects unsupported models with 400', async () => {
  const { server, baseUrl } = await makeStub()
  try {
    const daemon = makeDaemon(baseUrl)
    await assert.rejects(
      daemon.proxyChat({ model: 'claude/sonnet-999', messages: [] }),
      (err) => err.status === 400,
    )
  } finally {
    server.close()
  }
})

test('proxyChat prepends the canonical freebuff system prompt when missing', async () => {
  const { server, baseUrl, calls } = await makeStub()
  try {
    const daemon = makeDaemon(baseUrl)
    await daemon.proxyChat(chatBody)
    const sent = calls.chatBodies[0]
    const first = sent.messages[0]
    assert.equal(first.role, 'system')
    assert.ok(first.content.startsWith(INJECTED_SYSTEM_PROMPT))
    // the caller's message is preserved, after the injected prompt
    assert.deepEqual(sent.messages[1], chatBody.messages[0])
  } finally {
    server.close()
  }
})

test('proxyChat does not double-inject when messages already open canonically', async () => {
  const { server, baseUrl, calls } = await makeStub()
  try {
    const daemon = makeDaemon(baseUrl)
    const body = {
      ...chatBody,
      messages: [
        { role: 'system', content: INJECTED_SYSTEM_PROMPT },
        { role: 'user', content: 'hi' },
      ],
    }
    await daemon.proxyChat(body)
    const sent = calls.chatBodies[0]
    assert.equal(sent.messages.length, 2)
    assert.equal(sent.messages[0].role, 'system')
    assert.equal(sent.messages[0].content, INJECTED_SYSTEM_PROMPT)
    assert.equal(sent.messages[1].content, 'hi')
  } finally {
    server.close()
  }
})

test('proxyChat refuses when admission is refused outright', async () => {
  // No session can be admitted at all → chat must fail with 409, no chat call.
  const bus = new Bus()
  const store = {
    settings: { model: MODEL },
    user: { id: 'u1', authToken: 'tok' },
  }
  const client = {
    sessionRequest: async () => ({
      status: 'rate_limited',
      limit: 6,
      recentCount: 6,
      period: 'pacific_day',
    }),
    chat: async () => {
      throw new Error('chat must not be called')
    },
  }
  const daemon = new Daemon({ config: {}, bus, store, client })
  daemon._token = 'tok'
  await assert.rejects(
    daemon.proxyChat(chatBody),
    (err) => err.status === 409,
  )
})
