'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const http = require('node:http')

const { FreebuffClient, FreebuffError } = require('../src/freebuff')
const { Bus } = require('../src/bus')

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

function clientFor(baseUrl) {
  return new FreebuffClient({ baseUrl, chatBaseUrl: baseUrl, bus: new Bus() })
}

const ACTIVE_SESSION = {
  status: 'active',
  instanceId: 'inst-1',
  model: 'deepseek/deepseek-v4-pro',
  admittedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  remainingMs: 3_600_000,
  rateLimit: { limit: 6, period: 'pacific_day', recentCount: 1 },
}

// ---- login ---------------------------------------------------------------

test('loginCode POSTs the fingerprint and parses the code response', async () => {
  let seen = null
  const { server, baseUrl } = await startStub(async (req, res) => {
    seen = {
      method: req.method,
      url: req.url,
      body: await readJsonBody(req),
    }
    sendJson(res, 200, {
      loginUrl: 'https://freebuff.com/auth/cli?fp=1',
      fingerprintHash: 'h',
      expiresAt: '2099-01-01T00:00:00Z',
      expiresInMs: 3_600_000,
    })
  })
  try {
    const out = await clientFor(baseUrl).loginCode('codebuff-cli-abc123')
    assert.equal(seen.method, 'POST')
    assert.equal(seen.url, '/api/auth/cli/code')
    assert.deepEqual(seen.body, { fingerprintId: 'codebuff-cli-abc123' })
    assert.equal(out.loginUrl, 'https://freebuff.com/auth/cli?fp=1')
    assert.equal(out.fingerprintHash, 'h')
  } finally {
    server.close()
  }
})

test('loginCode throws FreebuffError on non-2xx', async () => {
  const { server, baseUrl } = await startStub((req, res) => sendJson(res, 500, {}))
  try {
    await assert.rejects(
      clientFor(baseUrl).loginCode('fp'),
      (err) => err instanceof FreebuffError && err.status === 500,
    )
  } finally {
    server.close()
  }
})

test('loginStatus GETs with the HMAC echo params and returns the user', async () => {
  let seen = null
  const { server, baseUrl } = await startStub((req, res) => {
    seen = { method: req.method, url: req.url }
    sendJson(res, 200, { user: { id: 'u1', email: 'a@b.c', authToken: 'tok' } })
  })
  try {
    const out = await clientFor(baseUrl).loginStatus({
      fingerprintId: 'fp',
      fingerprintHash: 'h',
      expiresAt: '2099-01-01T00:00:00Z',
    })
    assert.equal(seen.method, 'GET')
    const q = new URL(seen.url, baseUrl).searchParams
    assert.equal(q.get('fingerprintId'), 'fp')
    assert.equal(q.get('fingerprintHash'), 'h')
    assert.equal(q.get('expiresAt'), '2099-01-01T00:00:00Z')
    assert.equal(out.user.email, 'a@b.c')
  } finally {
    server.close()
  }
})

// ---- session -------------------------------------------------------------

test('sessionRequest POST sends x-freebuff-model and parses active', async () => {
  let headers = null
  const { server, baseUrl } = await startStub(async (req, res) => {
    headers = req.headers
    sendJson(res, 200, ACTIVE_SESSION)
  })
  try {
    const out = await clientFor(baseUrl).sessionRequest('POST', 'tok', {
      model: 'deepseek/deepseek-v4-pro',
    })
    assert.equal(headers.authorization, 'Bearer tok')
    assert.equal(headers['x-freebuff-model'], 'deepseek/deepseek-v4-pro')
    assert.equal(out.status, 'active')
    assert.equal(out.instanceId, 'inst-1')
  } finally {
    server.close()
  }
})

test('sessionRequest GET sends instance + compact headers', async () => {
  let headers = null
  const { server, baseUrl } = await startStub((req, res) => {
    headers = req.headers
    sendJson(res, 200, ACTIVE_SESSION)
  })
  try {
    await clientFor(baseUrl).sessionRequest('GET', 'tok', { instanceId: 'inst-1' })
    assert.equal(headers['x-freebuff-instance-id'], 'inst-1')
    assert.equal(headers['x-freebuff-compact-session'], '1')
  } finally {
    server.close()
  }
})

test('sessionRequest maps 404 to none and typed gate statuses', async () => {
  const cases = [
    { status: 404, body: null, expected: 'none' },
    { status: 403, body: { status: 'banned' }, expected: 'banned' },
    { status: 403, body: { status: 'country_blocked' }, expected: 'country_blocked' },
    { status: 409, body: { status: 'model_locked' }, expected: 'model_locked', post: true },
    { status: 409, body: { status: 'model_unavailable' }, expected: 'model_unavailable', post: true },
    { status: 429, body: { status: 'rate_limited' }, expected: 'rate_limited', post: true },
    { status: 429, body: { status: 'ip_capped' }, expected: 'ip_capped', post: true },
  ]
  for (const c of cases) {
    const { server, baseUrl } = await startStub((req, res) =>
      c.body ? sendJson(res, c.status, c.body) : (res.writeHead(404), res.end()),
    )
    try {
      const out = await clientFor(baseUrl).sessionRequest(
        c.post ? 'POST' : 'GET',
        'tok',
        { model: 'm' },
      )
      assert.equal(out.status, c.expected, `status ${c.status}`)
    } finally {
      server.close()
    }
  }
})

test('sessionRequest throws FreebuffError with code + retry-after for other errors', async () => {
  const { server, baseUrl } = await startStub((req, res) => {
    res.writeHead(400, { 'Retry-After': '120', 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'bad_request' }))
  })
  try {
    await assert.rejects(
      clientFor(baseUrl).sessionRequest('GET', 'tok', {}),
      (err) =>
        err instanceof FreebuffError &&
        err.status === 400 &&
        err.code === 'bad_request' &&
        err.retryAfterMs === 120_000,
    )
  } finally {
    server.close()
  }
})

// ---- ads -----------------------------------------------------------------

test('fetchAds sends auth, CLI UA, targeting body and parses ads', async () => {
  let seen = null
  const { server, baseUrl } = await startStub(async (req, res) => {
    seen = { method: req.method, url: req.url, headers: req.headers, body: await readJsonBody(req) }
    sendJson(res, 200, {
      provider: 'gravity',
      ads: [
        {
          title: 'A',
          adText: 'text',
          cta: 'Go',
          url: 'https://x.dev',
          favicon: '',
          clickUrl: 'https://x.dev/click',
          impUrl: 'https://x.dev/imp',
        },
      ],
    })
  })
  try {
    const out = await clientFor(baseUrl).fetchAds('tok', {
      surface: 'cli_chat',
      messages: [{ role: 'user', content: 'hi' }],
      sessionId: 's1',
    })
    assert.equal(seen.method, 'POST')
    assert.equal(seen.url, '/api/v1/ads')
    assert.equal(seen.headers.authorization, 'Bearer tok')
    assert.match(seen.headers['user-agent'], /^Freebuff-CLI\//)
    assert.equal(seen.body.provider, 'gravity')
    assert.equal(seen.body.surface, 'cli_chat')
    assert.equal(seen.body.sessionId, 's1')
    assert.deepEqual(seen.body.device, {
      os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      locale: Intl.DateTimeFormat().resolvedOptions().locale || 'en-US',
    })
    assert.match(seen.body.userAgent, /Chrome\/124/)
    assert.equal(out.ads[0].title, 'A')
    assert.equal(out.provider, 'gravity')
  } finally {
    server.close()
  }
})

test('fetchAds passes the requested provider through (fallback chain)', async () => {
  let seen = null
  const { server, baseUrl } = await startStub(async (req, res) => {
    seen = await readJsonBody(req)
    sendJson(res, 200, { ads: [], provider: seen.provider })
  })
  try {
    await clientFor(baseUrl).fetchAds('tok', {
      provider: 'carbon',
      surface: 'waiting_room',
      messages: [],
      sessionId: 's1',
    })
    assert.equal(seen.provider, 'carbon')
    assert.equal(seen.surface, 'waiting_room')
  } finally {
    server.close()
  }
})

test('reportImpression POSTs impUrl + mode and returns creditsGranted', async () => {
  let body = null
  const { server, baseUrl } = await startStub(async (req, res) => {
    body = await readJsonBody(req)
    sendJson(res, 200, { creditsGranted: 0 })
  })
  try {
    const out = await clientFor(baseUrl).reportImpression('tok', 'https://x.dev/imp', 'LITE')
    assert.equal(body.impUrl, 'https://x.dev/imp')
    assert.equal(body.mode, 'LITE')
    assert.equal(out.ok, true)
    assert.equal(out.body.creditsGranted, 0)
  } finally {
    server.close()
  }
})

test('reportClick POSTs impUrl and surface', async () => {
  let body = null
  const { server, baseUrl } = await startStub(async (req, res) => {
    body = await readJsonBody(req)
    sendJson(res, 200, {})
  })
  try {
    const ok = await clientFor(baseUrl).reportClick('tok', 'https://x.dev/imp', 'cli_chat')
    assert.equal(ok, true)
    assert.equal(body.impUrl, 'https://x.dev/imp')
    assert.equal(body.surface, 'cli_chat')
  } finally {
    server.close()
  }
})

test('me sends Authorization and only valid field names', async () => {
  let auth = null
  let url = null
  const { server, baseUrl } = await startStub((req, res) => {
    auth = req.headers.authorization
    url = req.url
    sendJson(res, 200, { id: 'u1' })
  })
  try {
    const out = await clientFor(baseUrl).me('tok-123')
    assert.equal(auth, 'Bearer tok-123')
    assert.equal(url, '/api/v1/me?fields=id,email')
    assert.equal(out.ok, true)
    assert.equal(out.body.id, 'u1')
  } finally {
    server.close()
  }
})

// ---- streak --------------------------------------------------------------

test('streak GETs the app surface with auth and parses the streak', async () => {
  let seen = null
  const { server, baseUrl } = await startStub((req, res) => {
    seen = { method: req.method, url: req.url, auth: req.headers.authorization }
    sendJson(res, 200, { streak: 7 })
  })
  try {
    const out = await clientFor(baseUrl).streak('tok-1')
    assert.equal(seen.method, 'GET')
    assert.equal(seen.url, '/api/v1/freebuff/streak')
    assert.equal(seen.auth, 'Bearer tok-1')
    assert.equal(out.streak, 7)
  } finally {
    server.close()
  }
})

test('streak throws FreebuffError on non-2xx', async () => {
  const { server, baseUrl } = await startStub((req, res) => sendJson(res, 403, {}))
  try {
    await assert.rejects(
      clientFor(baseUrl).streak('tok'),
      (err) => err instanceof FreebuffError && err.status === 403,
    )
  } finally {
    server.close()
  }
})

// ---- retry / backoff -----------------------------------------------------

test('me retries a 503 and succeeds on the second attempt', async () => {
  let calls = 0
  const { server, baseUrl } = await startStub((req, res) => {
    calls += 1
    if (calls === 1) return sendJson(res, 503, {})
    sendJson(res, 200, { id: 'u1' })
  })
  try {
    const out = await clientFor(baseUrl).me('tok')
    assert.equal(out.ok, true)
    assert.equal(calls, 2)
  } finally {
    server.close()
  }
})

test('loginCode honors Retry-After on 429 and succeeds after retry', async () => {
  let calls = 0
  const { server, baseUrl } = await startStub((req, res) => {
    calls += 1
    if (calls === 1) {
      res.writeHead(429, { 'Retry-After': '0', 'Content-Type': 'application/json' })
      res.end(JSON.stringify({}))
      return
    }
    sendJson(res, 200, { loginUrl: 'https://freebuff.com/auth/cli?x=1', fingerprintHash: 'h', expiresAt: '2099-01-01T00:00:00Z' })
  })
  try {
    const out = await clientFor(baseUrl).loginCode('fp')
    assert.equal(out.loginUrl.startsWith('https://freebuff.com'), true)
    assert.equal(calls, 2)
  } finally {
    server.close()
  }
})

// ---- base-URL surface split ------------------------------------------------

test('API calls route to the app surface, login to the auth surface', async () => {
  const seen = { auth: [], app: [], chat: [] }
  const { server: authServer, baseUrl: authUrl } = await startStub((req, res) => {
    seen.auth.push(req.url)
    sendJson(res, 200, {
      loginUrl: `${authUrl}/auth/cli?x=1`,
      fingerprintHash: 'h',
      expiresAt: '2099-01-01T00:00:00Z',
    })
  })
  const { server: appServer, baseUrl: appUrl } = await startStub((req, res) => {
    seen.app.push(req.url)
    if (req.url.startsWith('/api/v1/freebuff/session') && req.method === 'POST') {
      return sendJson(res, 200, ACTIVE_SESSION)
    }
    sendJson(res, 200, { id: 'u1' })
  })
  const { server: chatServer, baseUrl: chatUrl } = await startStub((req, res) => {
    seen.chat.push(req.url)
    sendJson(res, 200, {})
  })

  const client = new FreebuffClient({
    baseUrl: authUrl,
    appUrl,
    chatBaseUrl: chatUrl,
    bus: new Bus(),
  })
  try {
    await client.loginCode('fp')
    await client.me('tok')
    await client.sessionRequest('POST', 'tok', { model: 'deepseek/deepseek-v4-pro' })
    await client.startRun('tok', { agentId: 'base3-free-deepseek', userId: 'u1' })
    await client.streak('tok')
    await client.fetchAds('tok', { surface: 'cli_chat' })
    const res = await client.chat('tok', { model: 'm', messages: [] })
    await res.text()

    assert.deepEqual(seen.auth, ['/api/auth/cli/code'])
    const appPaths = seen.app.map((p) => p.split('?')[0])
    assert.ok(appPaths.includes('/api/v1/me'))
    assert.ok(appPaths.includes('/api/v1/freebuff/session'))
    assert.ok(appPaths.includes('/api/v1/agent-runs'))
    assert.ok(appPaths.includes('/api/v1/freebuff/streak'))
    assert.ok(appPaths.includes('/api/v1/ads'))
    assert.deepEqual(seen.chat, ['/api/v1/chat/completions'])
  } finally {
    authServer.close()
    appServer.close()
    chatServer.close()
  }
})

test('startRun POSTs action START to the app surface and parses runId', async () => {
  let seen = null
  const { server, baseUrl } = await startStub(async (req, res) => {
    const body = await readJsonBody(req)
    seen = { url: req.url, body, auth: req.headers.authorization, actingUser: req.headers['x-freebuff-acting-user-id'] }
    sendJson(res, 200, { runId: 'run-abc' })
  })
  try {
    const out = await clientFor(baseUrl).startRun('tok-1', {
      agentId: 'base3-free-deepseek',
      userId: 'u-42',
    })
    assert.equal(out, 'run-abc')
    assert.equal(seen.url, '/api/v1/agent-runs')
    assert.deepEqual(seen.body, { action: 'START', agentId: 'base3-free-deepseek' })
    assert.equal(seen.auth, 'Bearer tok-1')
    assert.equal(seen.actingUser, 'u-42')
  } finally {
    server.close()
  }
})

test('appUrl defaults to www.codebuff.com for prod and to baseUrl for localhost stubs', () => {
  const prod = new FreebuffClient({ baseUrl: 'https://freebuff.com', bus: new Bus() })
  assert.equal(prod.baseUrl, 'https://freebuff.com')
  assert.equal(prod.appUrl, 'https://www.codebuff.com')
  assert.equal(prod.chatBaseUrl, 'https://www.codebuff.com')

  const local = new FreebuffClient({ baseUrl: 'http://127.0.0.1:9999', bus: new Bus() })
  assert.equal(local.appUrl, 'http://127.0.0.1:9999')

  const explicit = new FreebuffClient({
    baseUrl: 'https://a.example',
    appUrl: 'https://b.example',
    chatBaseUrl: 'https://c.example',
    bus: new Bus(),
  })
  assert.equal(explicit.appUrl, 'https://b.example')
  assert.equal(explicit.chatBaseUrl, 'https://c.example')
})
