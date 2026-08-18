'use strict'

// Live-backend end-to-end smoke. Proves the parts no hermetic test can: the
// real token validates, a real session is adopted/admitted, ads fetch
// (read-only — never reports impressions), and a minimal chat passes the
// free-mode gate through the actual proxy (run_id + canonical system prompt +
// freebuff_instance_id). Opt-in: skipped unless FREEBUFF_LIVE=1, so `npm test`
// stays hermetic. Credential precedence matches the daemon: port state →
// official CLI credentials → CODEBUFF_API_KEY. If the test admits a session it
// releases it; an existing session is adopted and left untouched.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')

const { Bus } = require('../src/bus')
const { Store } = require('../src/store')
const { FreebuffClient } = require('../src/freebuff')
const { Daemon } = require('../src/daemon')
const { Server } = require('../src/server')

function resolveConfig() {
  const appUrl =
    process.env.FREEBUFF_APP_URL ||
    process.env.NEXT_PUBLIC_CODEBUFF_APP_URL ||
    process.env.CODEBUFF_APP_URL ||
    'https://www.codebuff.com'
  return {
    host: '127.0.0.1',
    port: 0, // ephemeral — never collides with a running daemon
    baseUrl: process.env.FREEBUFF_BASE_URL || 'https://freebuff.com',
    appUrl,
    chatBaseUrl: process.env.FREEBUFF_CHAT_BASE_URL || appUrl,
    proxyKey: '',
    mock: false,
  }
}

function resolveToken(store) {
  if (store.user?.authToken) return { token: store.user.authToken, via: 'freebuff-adapter state' }
  if (store.officialUser?.authToken) {
    return { token: store.officialUser.authToken, via: 'official CLI credentials' }
  }
  if (process.env.CODEBUFF_API_KEY) return { token: process.env.CODEBUFF_API_KEY, via: 'CODEBUFF_API_KEY' }
  return null
}

const AD_CANDIDATES = [
  { provider: 'gravity', surface: 'cli_chat' },
  { provider: 'gravity', surface: 'waiting_room' },
  { provider: 'carbon', surface: 'waiting_room' },
  { provider: 'carbon', surface: 'cli_chat' },
]

const envGate =
  process.env.FREEBUFF_LIVE !== '1' ? 'set FREEBUFF_LIVE=1 to run the live-backend e2e' : false
const store = new Store(new Bus())
const creds = envGate ? null : resolveToken(store)

test(
  'live backend: token, session, ads fetch, chat gate through the proxy',
  {
    skip: envGate || (!creds ? 'no Freebuff credentials found (login first or set CODEBUFF_API_KEY)' : false),
    timeout: 240_000,
  },
  async (t) => {
    const config = resolveConfig()
    const bus = new Bus()
    const client = new FreebuffClient({
      baseUrl: config.baseUrl,
      appUrl: config.appUrl,
      chatBaseUrl: config.chatBaseUrl,
      bus,
    })
    const daemon = new Daemon({ config, bus, store, client })
    const server = new Server({ config, bus, store, daemon })
    let admitted = false // release only a session this test created

    try {
      daemon._token = creds.token
      daemon._tokenSource = creds.via
      daemon.knownUser = { email: store.user?.email || null }

      await server.start()
      const base = `http://127.0.0.1:${server.server.address().port}`
      t.diagnostic(`proxy on ${base} · credentials via ${creds.via}`)

      // 1. Token validation.
      const me = await client.me(creds.token)
      assert.equal(me.ok, true, `token rejected: HTTP ${me.status}`)
      t.diagnostic(`token ok (${me.body?.email ?? 'no email field'})`)

      // 2. Session: adopt an existing active one; otherwise admit and release.
      let session = await client.sessionRequest('GET', creds.token, {})
      if (session.status !== 'active' && !(session.status === 'ended' && session.instanceId)) {
        const res = await daemon.admitSession(store.settings.model, { quiet: true })
        assert.ok(res?.instanceId, `session admission refused: ${res?.status ?? 'null'}`)
        admitted = true
        session = daemon.session
        t.diagnostic(`session admitted (${session.model})`)
      } else {
        daemon.session = session
        t.diagnostic(`existing session adopted (${session.model})`)
      }
      assert.equal(session.status, 'active')
      assert.ok(session.instanceId)

      // 3. Ads fetch — read-only, no impressions reported.
      const model = session.model || store.settings.model
      const sessionId = randomUUID()
      let fetched = null
      for (const cand of AD_CANDIDATES) {
        try {
          const r = await client.fetchAds(creds.token, {
            provider: cand.provider,
            surface: cand.surface,
            messages: [],
            sessionId,
          })
          if (r?.ads?.length) {
            fetched = r
            break
          }
        } catch (err) {
          t.diagnostic(`ads ${cand.provider}/${cand.surface}: ${err.message}`)
        }
      }
      assert.ok(fetched, 'no ad inventory from any candidate')
      // Live carbon ads can omit the destination url; impUrl/title/adText are
      // the contract the port actually relies on.
      assert.ok(
        fetched.ads.every((a) => a.impUrl && a.title && a.adText),
        'ad shape incomplete (impUrl/title/adText)',
      )
      if (fetched.ads.some((a) => !a.url)) {
        t.diagnostic('some ads have no destination url (carbon) — CTA hidden in UI')
      }
      t.diagnostic(`ads ok (${fetched.ads.length} from ${fetched.provider})`)

      // 4. Chat gate: one minimal non-streaming call through the real proxy.
      const chatRes = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
          stream: false,
        }),
      })
      const chatBody = await chatRes.json().catch(() => null)
      assert.equal(
        chatRes.status,
        200,
        `chat rejected upstream: HTTP ${chatRes.status} ${chatBody?.error?.message ?? ''}`,
      )
      const content = chatBody?.choices?.[0]?.message?.content ?? ''
      assert.ok(content.length > 0, 'chat returned no content')
      assert.ok(chatBody?.usage?.prompt_tokens > 0, 'chat returned no usage')
      t.diagnostic(`chat ok — ${content.replace(/\s+/g, ' ').slice(0, 60)}…`)

      // 5. The UI surface agrees: state snapshot over HTTP, real backend.
      const stateRes = await fetch(`${base}/api/state`)
      const stateBody = await stateRes.json()
      assert.equal(stateRes.status, 200)
      assert.equal(stateBody.config.mock, false)
      assert.equal(stateBody.state.session.status, 'active')
      t.diagnostic('proxy + UI state healthy')
    } finally {
      if (admitted) await daemon.releaseSession({ quiet: true })
      server.stop()
    }
  },
)
