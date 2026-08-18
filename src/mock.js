'use strict'

const http = require('node:http')
const { randomUUID } = require('node:crypto')

const { hasCanonicalSystemPrompt } = require('./freebuff-prompt')

/**
 * In-process mock of the Freebuff backend (FREEBUFF_MOCK=1). Lets the whole
 * port — login, session admission, ads + impressions, chat proxy — be
 * exercised end-to-end without a real account. The mock auto-approves the
 * device-code login after a couple of status polls and serves a canned
 * streaming chat completion.
 */

const nowIso = () => new Date().toISOString()

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

class MockUpstream {
  constructor() {
    this.port = 0
    this.polls = new Map() // fingerprintId -> count
    this.sessions = new Map() // token -> { instanceId, model, admittedAt, expiresAt }
    this.adSequence = 0
    this.chatCalls = new Map() // token -> count
    this.impressions = []
    this.chaos = process.env.FREEBUFF_MOCK_CHAOS === '1'
    this.server = http.createServer((req, res) => this.handle(req, res))
  }

  async start() {
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.port = this.server.address().port
    return this.port
  }

  stop() {
    this.server.close()
  }

  base() {
    return `http://127.0.0.1:${this.port}`
  }

  async handle(req, res) {
    const url = new URL(req.url, this.base())
    const p = url.pathname
    const method = req.method
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/, '')
    const model = req.headers['x-freebuff-model']

    if (method === 'POST' && p === '/api/auth/cli/code') {
      const body = await readJsonBody(req)
      const fp = body.fingerprintId
      this.polls.set(fp, 0)
      return json(res, 200, {
        loginUrl: `${this.base()}/mock-login?fingerprintId=${encodeURIComponent(fp)}`,
        fingerprintHash: `mock-hash-${fp}`,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        expiresInMs: 3_600_000,
      })
    }

    if (method === 'GET' && p === '/api/auth/cli/status') {
      const fp = url.searchParams.get('fingerprintId')
      const count = (this.polls.get(fp) ?? 0) + 1
      this.polls.set(fp, count)
      if (count < 2) return json(res, 200, {})
      return json(res, 200, {
        user: {
          id: `user_mock_${fp.slice(-6)}`,
          name: 'Mock Freebuff User',
          email: `mock+${fp.slice(-6)}@freebuff.test`,
          authToken: `mock-token-${fp}`,
          fingerprintId: fp,
          fingerprintHash: `mock-hash-${fp}`,
          credits: 0,
        },
      })
    }

    if (method === 'GET' && p === '/mock-login') {
      // Approve the login immediately when opened in a browser.
      const fp = url.searchParams.get('fingerprintId')
      this.polls.set(fp, 99)
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<h1>Mock Freebuff sign-in</h1><p>You are signed in. Close this tab.</p>')
      return
    }

    if (method === 'POST' && p === '/api/auth/cli/logout') {
      return json(res, 200, { ok: true })
    }

    if (method === 'GET' && p === '/api/v1/me') {
      if (!token) return json(res, 401, { error: 'unauthorized' })
      return json(res, 200, {
        id: `user_mock_${token.slice(-6)}`,
        email: `mock+${token.slice(-6)}@freebuff.test`,
        name: 'Mock Freebuff User',
      })
    }

    if (method === 'GET' && p === '/api/v1/freebuff/streak') {
      // Daily streak is derived server-side from usage; serve a fixed mock.
      return json(res, 200, { streak: 3 })
    }

    if (method === 'POST' && p === '/api/v1/agent-runs') {
      // Mirrors the real backend: chat-completions requires the runId returned
      // here (sent as top-level codebuff_metadata.run_id).
      return json(res, 200, { runId: `mock-run-${randomUUID().slice(0, 8)}` })
    }

    if (p === '/api/v1/freebuff/session') {
      if (method === 'GET') {
        const session = this.sessions.get(token)
        if (!session) {
          res.writeHead(404)
          return res.end()
        }
        if (Date.now() > Date.parse(session.expiresAt)) {
          this.sessions.delete(token)
          return json(res, 200, { status: 'ended', instanceId: session.instanceId, model: session.model })
        }
        return json(res, 200, this.activeSession(token, session))
      }
      if (method === 'POST') {
        const instanceId = `mock-instance-${randomUUID().slice(0, 8)}`
        const session = {
          instanceId,
          model: model || 'deepseek/deepseek-v4-pro',
          admittedAt: nowIso(),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }
        this.sessions.set(token, session)
        return json(res, 200, this.activeSession(token, session))
      }
      if (method === 'DELETE') {
        this.sessions.delete(token)
        return json(res, 200, { ok: true })
      }
    }

    if (method === 'POST' && p === '/api/v1/ads') {
      this.adSequence += 1
      const i = this.adSequence
      const ads = [
        {
          title: 'Mock Gravity Ad A',
          adText: 'Ship faster with the mock ad network. Impressions reported to the local ledger.',
          cta: 'Try it',
          url: 'https://example.com/a',
          favicon: '',
          clickUrl: `${this.base()}/mock-click/a`,
          impUrl: `https://mock.ads/imp/${i}/a`,
          provider: 'gravity',
        },
        {
          title: 'Mock Gravity Ad B',
          adText: 'The UI is the ad viewer — every rotation reports an impression once.',
          cta: 'Learn more',
          url: 'https://example.com/b',
          favicon: '',
          clickUrl: `${this.base()}/mock-click/b`,
          impUrl: `https://mock.ads/imp/${i}/b`,
          provider: 'gravity',
        },
      ]
      return json(res, 200, { ads, provider: 'gravity' })
    }

    if (method === 'POST' && p === '/api/v1/ads/impression') {
      const body = await readJsonBody(req)
      this.impressions.push({ impUrl: body.impUrl, mode: body.mode, at: nowIso() })
      return json(res, 200, { creditsGranted: 0 })
    }

    if (method === 'POST' && p === '/api/v1/ads/click') {
      return json(res, 200, { ok: true })
    }

    if (method === 'POST' && p === '/api/v1/chat/completions') {
      const body = await readJsonBody(req)
      // The real backend gates free-mode chat on the canonical system prompt
      // opening; mirror it so mock mode stays faithful.
      if (!hasCanonicalSystemPrompt(body?.messages)) {
        return json(res, 403, {
          error: 'free_mode_cli_required',
          message:
            'Free mode is only available through the freebuff CLI. Calling the API directly is not supported.',
        })
      }
      // The gate reads the top-level codebuff_metadata (the newer contract);
      // keep the nested providerOptions shape as a fallback.
      const metadata =
        body?.codebuff_metadata ??
        body?.providerOptions?.codebuff?.codebuff_metadata ??
        {}
      const instanceId = metadata.freebuff_instance_id
      const session = this.sessions.get(token)

      // Chaos mode: reject the first chat call per token to exercise the
      // session-gate re-admission path.
      if (this.chaos) {
        const count = (this.chatCalls.get(token) ?? 0) + 1
        this.chatCalls.set(token, count)
        if (count === 1) {
          return json(res, 410, { error: 'session_expired' })
        }
      }
      if (!session || session.instanceId !== instanceId) {
        return json(res, 410, { error: 'session_expired' })
      }
      return this.serveCompletion(req, res, body)
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: `mock: no route ${method} ${p}` }))
  }

  activeSession(token, session) {
    const expiresAt = Date.parse(session.expiresAt)
    return {
      status: 'active',
      instanceId: session.instanceId,
      model: session.model,
      admittedAt: session.admittedAt,
      expiresAt: session.expiresAt,
      remainingMs: Math.max(0, expiresAt - Date.now()),
      rateLimit: {
        model: session.model,
        limit: 6,
        period: 'pacific_day',
        resetTimeZone: 'America/Los_Angeles',
        resetAt: new Date(Date.now() + 86_400_000).toISOString(),
        recentCount: 1,
        entitlementBreakdown: { base: 6, referral: 0, streak: 0, promo: 0 },
      },
    }
  }

  serveCompletion(req, res, body) {
    const model = body.model || 'deepseek/deepseek-v4-pro'
    const id = `chatcmpl-mock-${randomUUID().slice(0, 8)}`
    const created = Math.floor(Date.now() / 1000)

    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const chunks = [
        { role: 'assistant', content: 'Hello from mock Freebuff' },
        { content: ' (streaming through the local proxy).' },
      ]
      let i = 0
      const timer = setInterval(() => {
        if (i < chunks.length) {
          const delta = chunks[i]
          res.write(
            `data: ${JSON.stringify({
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta, finish_reason: null }],
            })}\n\n`,
          )
          i += 1
          return
        }
        res.write(
          `data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14 },
          })}\n\n`,
        )
        res.write('data: [DONE]\n\n')
        clearInterval(timer)
        res.end()
      }, 120)
      // Client (the daemon's proxy) aborted mid-stream: stop the rotation.
      res.on('close', () => clearInterval(timer))
      res.on('error', () => clearInterval(timer))
      return
    }

    return json(res, 200, {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Hello from mock Freebuff (non-streaming).' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14 },
    })
  }
}

module.exports = { MockUpstream }
