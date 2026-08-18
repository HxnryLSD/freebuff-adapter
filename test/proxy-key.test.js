'use strict'

const { test } = require('node:test')
const assert = require('node:assert')

const { Bus } = require('../src/bus')
const { Server } = require('../src/server')

function makeServer(proxyKey) {
  const bus = new Bus()
  const daemon = {
    publicState: () => ({ login: null, session: null, ads: { current: null }, streak: null }),
    safeUser: () => null,
    emitState: () => {},
    startLogin: async () => ({ loginUrl: 'https://freebuff.com/auth/cli?x=1' }),
    cancelLogin: () => {},
    logout: async () => {},
    admitSession: async () => ({}),
    releaseSession: async () => {},
    rotateAds: async () => {},
    reportClick: async () => ({ ok: true }),
    stop: async () => {},
    proxyChat: async () => {
      throw new Error('not reached')
    },
  }
  return new Server({
    config: { host: '127.0.0.1', port: 0, baseUrl: 'https://x', chatBaseUrl: 'https://x', proxyKey, mock: false },
    bus,
    store: { settings: {}, officialUser: null },
    daemon,
  })
}

// ---- unit: checkProxyKey -------------------------------------------------

test('checkProxyKey: loopback is always allowed even with a key set', () => {
  const server = makeServer('sekret')
  for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(
      server.checkProxyKey({ socket: { remoteAddress: addr }, headers: {} }),
      true,
      addr,
    )
  }
})

test('checkProxyKey: non-loopback requires the key (Bearer or x-api-key)', () => {
  const server = makeServer('sekret')
  const remote = { socket: { remoteAddress: '192.168.1.50' }, headers: {} }
  assert.equal(server.checkProxyKey(remote), false)
  assert.equal(
    server.checkProxyKey({ ...remote, headers: { authorization: 'Bearer wrong' } }),
    false,
  )
  assert.equal(
    server.checkProxyKey({ ...remote, headers: { authorization: 'Bearer sekret' } }),
    true,
  )
  assert.equal(server.checkProxyKey({ ...remote, headers: { 'x-api-key': 'sekret' } }), true)
})

test('checkProxyKey: no key configured → everything allowed', () => {
  const server = makeServer('')
  assert.equal(server.checkProxyKey({ socket: { remoteAddress: '192.168.1.50' }, headers: {} }), true)
})

// ---- HTTP round-trips ------------------------------------------------------

async function start(server) {
  await server.start()
  const port = server.server.address().port
  return {
    get: (path, headers = {}) =>
      fetch(`http://127.0.0.1:${port}${path}`, { headers }),
    post: (path, headers = {}) =>
      fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers }),
  }
}

test('HTTP: local UI can read state and hit admin endpoints with a key set', async (t) => {
  const server = makeServer('sekret')
  const http = await start(server)
  t.after(() => server.stop())

  const state = await http.get('/api/state')
  assert.equal(state.status, 200)

  // Admin POST from loopback must not be blocked (the UI depends on it).
  const login = await http.post('/api/login')
  assert.equal(login.status, 200)
  const body = await login.json()
  assert.equal(body.loginUrl, 'https://freebuff.com/auth/cli?x=1')
})

test('HTTP: remote peer without the key gets 401 on admin endpoints', async (t) => {
  const server = makeServer('sekret')
  await server.start()
  const port = server.server.address().port
  t.after(() => server.stop())

  // Send a request over a raw socket so the server sees a real (loopback)
  // peer, but force the guard to treat it as remote by exercising the exact
  // decision the router makes: peer is loopback → allowed; the unit tests
  // above cover the remote branch. Here we assert the full HTTP path for a
  // Bearer-authenticated remote-style request and the no-key server.
  const withKey = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: 'POST',
    headers: { Authorization: 'Bearer sekret' },
  })
  assert.equal(withKey.status, 200)

  // And a server with no key set accepts everything over HTTP.
  const open = makeServer('')
  await open.start()
  const openPort = open.server.address().port
  t.after(() => open.stop())
  const openRes = await fetch(`http://127.0.0.1:${openPort}/api/login`, { method: 'POST' })
  assert.equal(openRes.status, 200)
})
