'use strict'

const { test } = require('node:test')
const assert = require('node:assert')

const { Bus } = require('../src/bus')
const { Daemon } = require('../src/daemon')
const { Server } = require('../src/server')
const { MODELS } = require('../src/models')

const MODEL = MODELS[0].id

function fakeStore() {
  return {
    user: { id: 'u1', name: 'Tester', email: 'a@b.c', authToken: 'tok' },
    settings: { model: MODEL, adsEnabled: true, autoAdmit: true },
    officialUser: null,
  }
}

function fakeDaemon() {
  return new Daemon({
    config: {},
    bus: new Bus(),
    store: fakeStore(),
    client: {},
  })
}

/** A pending login exactly as the daemon holds it mid-flow — timer included. */
function pendingLoginWithTimer() {
  return {
    status: 'pending',
    loginUrl: 'https://freebuff.com/auth/cli?fingerprintId=fp&expiresAt=1',
    fingerprintHash: 'h',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    startedAt: new Date().toISOString(),
    attempts: 3,
    pollTimer: setInterval(() => {}, 1000),
  }
}

test('regression: the raw login object with its poll timer is circular', () => {
  const login = pendingLoginWithTimer()
  assert.throws(() => JSON.stringify(login))
  clearInterval(login.pollTimer)
})

test('publicState strips the poll timer so state serializes safely', () => {
  const daemon = fakeDaemon()
  daemon.login = pendingLoginWithTimer()
  try {
    const state = daemon.publicState()
    assert.equal(state.login.pollTimer, undefined)
    assert.equal('pollTimer' in state.login, false)
    assert.doesNotThrow(() => JSON.stringify(state))
    const roundTripped = JSON.parse(JSON.stringify(state))
    assert.equal(roundTripped.login.attempts, 3)
    assert.equal(roundTripped.login.status, 'pending')
  } finally {
    clearInterval(daemon.login.pollTimer)
  }
})

test('fullState serializes with a pending login holding a live timer', () => {
  const bus = new Bus()
  const daemon = new Daemon({ config: {}, bus, store: fakeStore(), client: {} })
  daemon.login = pendingLoginWithTimer()
  const server = new Server({ config: { host: '127.0.0.1', port: 1, baseUrl: 'https://x', chatBaseUrl: 'https://x', proxyKey: '', mock: false }, bus, store: fakeStore(), daemon })
  try {
    const snapshot = server.fullState()
    assert.doesNotThrow(() => JSON.stringify(snapshot))
    const parsed = JSON.parse(JSON.stringify(snapshot))
    assert.equal(parsed.state.login.status, 'pending')
  } finally {
    clearInterval(daemon.login.pollTimer)
  }
})

test('writeSse never throws on unserializable payloads and writes healthy ones', () => {
  const bus = new Bus()
  const daemon = new Daemon({ config: {}, bus, store: fakeStore(), client: {} })
  const server = new Server({ config: {}, bus, store: fakeStore(), daemon })

  const writes = []
  const fakeRes = { write: (chunk) => (writes.push(String(chunk)), true) }

  const circular = { type: 'state', state: { a: {} } }
  circular.state.a.self = circular.state
  assert.doesNotThrow(() => server.writeSse(fakeRes, circular))
  assert.equal(writes.length, 0, 'nothing may be written for a broken payload')

  server.writeSse(fakeRes, { type: 'report', entry: { id: 1, name: 'x' } })
  assert.equal(writes.length, 1)
  assert.ok(writes[0].startsWith('data: '))
  assert.ok(writes[0].includes('"type":"report"'))
})

test('bus events carrying daemon state stay serializable end to end', () => {
  const bus = new Bus()
  const daemon = new Daemon({ config: {}, bus, store: fakeStore(), client: {} })
  daemon.login = pendingLoginWithTimer()
  const server = new Server({ config: {}, bus, store: fakeStore(), daemon })

  const frames = []
  const fakeRes = { write: (chunk) => (frames.push(String(chunk)), true) }
  server.clients.add(fakeRes)
  try {
    // This is exactly the path that broke the login flow before: the daemon
    // emits state (with the pending login) and the server serializes it for
    // every SSE client.
    assert.doesNotThrow(() => daemon.emitState())
    assert.ok(frames.length >= 1)
    const parsed = JSON.parse(frames[0].slice(6))
    assert.equal(parsed.type, 'state')
  } finally {
    clearInterval(daemon.login.pollTimer)
    server.clients.delete(fakeRes)
  }
})

test('bus.snapshot is JSON-safe with logs, reports and finished tasks', () => {
  const bus = new Bus()
  bus.info('hello', { count: 1 })
  bus.warn('careful')
  bus.error('boom')
  bus.report('impression_reported', { title: 'Ad A', creditsGranted: 0 })
  const task = bus.task('t1', 'some task')
  task.done({ instanceId: 'i1' })
  assert.doesNotThrow(() => JSON.stringify(bus.snapshot()))
  const snap = JSON.parse(JSON.stringify(bus.snapshot()))
  assert.equal(snap.errors.length, 1)
  assert.equal(snap.warnings.length, 1)
  assert.equal(snap.reports[0].name, 'impression_reported')
  assert.equal(snap.tasks[0].status, 'done')
})
