'use strict'

const { test } = require('node:test')
const assert = require('node:assert')

const { Bus } = require('../src/bus')
const { Daemon, pacificDateKey } = require('../src/daemon')
const { MODELS } = require('../src/models')

const MODEL = MODELS[0].id

test('_finishLogin ignores a second completion from a racing poll tick', async () => {
  let admits = 0
  const bus = new Bus()
  const store = {
    settings: { model: MODEL, autoAdmit: true },
    user: null,
    setUser: (u) => { store.user = u },
    setFingerprint: () => {},
  }
  const client = {
    sessionRequest: async (method) => {
      if (method === 'POST') {
        admits += 1
        return {
          status: 'active',
          instanceId: 'inst-1',
          model: MODEL,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          remainingMs: 3_600_000,
        }
      }
      return { status: 'none' }
    },
  }
  const daemon = new Daemon({ config: {}, bus, store, client })
  daemon.login = {
    status: 'pending',
    loginUrl: 'https://freebuff.com/auth/cli?x=1',
    fingerprintHash: 'h',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    startedAt: new Date().toISOString(),
    attempts: 2,
    pollTimer: setInterval(() => {}, 1000),
  }
  try {
    const user = { id: 'u1', email: 'a@b.c', name: 'A', authToken: 't' }
    await daemon._finishLogin(user)
    // Second completion (e.g. an overlapping poll tick that resolved late, or
    // a cancelled login's in-flight request) must be a no-op.
    await daemon._finishLogin(user)
    assert.equal(admits, 1, 'session admitted exactly once')
    assert.equal(store.user, user)
  } finally {
    clearInterval(daemon.login?.pollTimer)
  }
})

test('streak check-in runs once per Pacific day and reports to the UI', async () => {
  const bus = new Bus()
  let calls = 0
  const store = {
    settings: { model: MODEL, autoAdmit: true },
    user: null,
    streakCheckDate: null,
    setStreakCheckDate: (d) => { store.streakCheckDate = d },
  }
  const client = {
    streak: async () => { calls += 1; return { streak: 4 } },
  }
  const daemon = new Daemon({ config: {}, bus, store, client })

  // not logged in: the check-in is a no-op
  await daemon.maybeCheckInStreak()
  assert.equal(calls, 0)

  daemon._token = 'tok'
  await daemon.checkInStreak()
  assert.equal(calls, 1)
  assert.equal(store.streakCheckDate, pacificDateKey())
  assert.equal(daemon.streak.value, 4)
  assert.ok(daemon.bus.reports.some((r) => r.name === 'streak_checked' && r.streak === 4))
  assert.equal(daemon.publicState().streak.checkedToday, true)

  // same-day re-checks are skipped by the once-per-day gate
  await daemon.maybeCheckInStreak()
  assert.equal(calls, 1)

  // a forced check bypasses the gate
  await daemon.checkInStreak()
  assert.equal(calls, 2)
})

test('streak check-in failure is reported and does not persist the day', async () => {
  const bus = new Bus()
  let calls = 0
  const store = {
    settings: { model: MODEL },
    user: null,
    streakCheckDate: null,
    setStreakCheckDate: (d) => { store.streakCheckDate = d },
  }
  const client = {
    streak: async () => {
      calls += 1
      const err = new Error('boom')
      err.status = 500
      throw err
    },
  }
  const daemon = new Daemon({ config: {}, bus, store, client })
  daemon._token = 'tok'

  await daemon.checkInStreak()
  assert.equal(calls, 1)
  assert.equal(store.streakCheckDate, null)
  assert.equal(daemon.streak.value, null)
  assert.ok(daemon.bus.reports.some((r) => r.name === 'streak_check_failed'))
  assert.ok(daemon.bus.warnings.length > 0)
})

test('ad rotation caps the viewer batch, dedupes impressions, and reports fetched count', async () => {
  const bus = new Bus()
  const store = {
    settings: { model: MODEL, adsEnabled: true },
    user: null,
  }
  const ads = Array.from({ length: 8 }, (_, i) => ({
    impUrl: `https://mock.ads/imp/${i}`,
    title: `Ad ${i}`,
    adText: `text ${i}`,
    provider: 'gravity',
  }))
  let reported = []
  const client = {
    fetchAds: async () => ({ provider: 'gravity', ads }),
    reportImpression: async (_t, impUrl) => {
      reported.push(impUrl)
      return { ok: true, status: 200, body: { creditsGranted: 0 } }
    },
  }
  const daemon = new Daemon({ config: {}, bus, store, client })
  daemon._token = 'tok'

  await daemon.rotateAds()

  // The viewer (and the impressions) are capped to MAX_AD_VIEW = 3; the full
  // batch size is still surfaced so the UI can say "3 shown of 8".
  assert.equal(daemon.ads.current.length, 3)
  assert.equal(daemon.ads.lastFetchedCount, 8)
  assert.equal(daemon.publicState().ads.current.length, 3)
  assert.equal(daemon.publicState().ads.fetchedCount, 8)
  assert.equal(reported.length, 3, 'impressions fire only for displayed ads')
  assert.equal(daemon.ads.impressionsFired.size, 3)

  // A second rotation with the same ads must not double-report impressions.
  reported = []
  await daemon.rotateAds()
  assert.equal(reported.length, 0, 'dedupe by impUrl suppresses re-impressions')
  assert.equal(daemon.ads.impressionsFired.size, 3)
})

test('ad rotation falls back to the cache when the fetch returns nothing', async () => {
  const bus = new Bus()
  const store = { settings: { model: MODEL, adsEnabled: true }, user: null }
  const ads = [
    { impUrl: 'https://mock.ads/cache/1', title: 'Cached', adText: 't', provider: 'gravity' },
    { impUrl: 'https://mock.ads/cache/2', title: 'Cached 2', adText: 't2', provider: 'gravity' },
  ]
  const client = {
    fetchAds: async () => ({ provider: 'gravity', ads: [] }),
    reportImpression: async () => ({ ok: true, status: 200, body: {} }),
  }
  const daemon = new Daemon({ config: {}, bus, store, client })
  daemon._token = 'tok'
  daemon._cacheAds(ads)

  await daemon.rotateAds()
  assert.equal(daemon.ads.current.length, 2)
  assert.equal(daemon.ads.current[0].title, 'Cached')
  assert.ok(
    daemon.bus.tasks.get('ads.rotate').status === 'done' ||
      daemon.bus.tasks.get('ads.rotate').status === 'error',
  )
})

test('applySettings reschedules the ad rotation timer in place', async () => {
  const daemon = new Daemon({
    config: {},
    bus: new Bus(),
    store: { settings: { model: MODEL, adIntervalMs: 60_000 }, user: null },
    client: {},
  })
  try {
    // Arm the cadence the way start() does, then change the setting.
    daemon.applySettings({ adIntervalMs: 60_000 })
    const before = daemon._timers.get('adRotation')
    assert.ok(before, 'ad rotation timer armed')
    daemon.applySettings({ adIntervalMs: 5_000 })
    const after = daemon._timers.get('adRotation')
    assert.notEqual(after, before, 'a new timer replaces the old one')
    assert.equal(daemon._timers.size, 1, 'rescheduling replaces in place, no growth')
    // unrelated patches must not touch the timers
    daemon.applySettings({ adsEnabled: false })
    assert.equal(daemon._timers.get('adRotation'), after)
  } finally {
    for (const t of daemon._timers.values()) clearInterval(t)
  }
})
