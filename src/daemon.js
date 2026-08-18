'use strict'

const { randomUUID } = require('node:crypto')
const { spawn } = require('node:child_process')

const { getFingerprintId } = require('./fingerprint')
const { MODELS } = require('./models')
const { withCanonicalSystemPrompt } = require('./freebuff-prompt')

/**
 * Freebuff CLI root agents per model (common/src/constants/free-agents.ts).
 * The chat gate requires a server-side run started for one of these roots;
 * the returned runId is sent as top-level codebuff_metadata.run_id.
 */
const AGENT_ID_BY_MODEL = {
  'deepseek/deepseek-v4-pro': 'base3-free-deepseek',
  'deepseek/deepseek-v4-flash': 'base3-free-deepseek-flash',
  'openai/gpt-5.6-luna': 'base3-free-luna',
  'minimax/minimax-m3': 'base3-free-minimax-m3',
  'mimo/mimo-v2.5': 'base3-free-mimo',
  'z-ai/glm-5.2': 'base3-free-glm',
}

const DEFAULT_AGENT_ID = AGENT_ID_BY_MODEL['deepseek/deepseek-v4-pro']

const SESSION_POLL_MS = 30_000
const LOGIN_POLL_MS = 5_000
const LOGIN_TIMEOUT_MS = 5 * 60_000
const MAX_AD_CACHE_SIZE = 50
// Cap displayed ads; impressions fire only for what's shown.
const MAX_AD_VIEW = 3
const ZEROCLICK_IMPRESSIONS_URL = 'https://zeroclick.dev/api/v2/impressions'

// The daily streak boundary is the Pacific day, like the official client's
// premium-session reset (FREEBUFF_STREAK_TIME_ZONE in the official repo).
const STREAK_TIME_ZONE = 'America/Los_Angeles'
const STREAK_BUFFER_MS = 5_000 // grace after midnight so the day has flipped
const STREAK_MIN_DELAY_MS = 60_000 // never busy-loop on a DST-miscalculated midnight

/**
 * Ad provider/surface candidates, tried in order until one returns inventory.
 * The official client requests gravity and the server is documented to fall
 * back to carbon/zeroclick, but on the live backend gravity currently returns
 * no ads for some accounts/regions while carbon + 'waiting_room' does.
 */
const AD_CANDIDATES = [
  { provider: 'gravity', surface: 'cli_chat' },
  { provider: 'gravity', surface: 'waiting_room' },
  { provider: 'carbon', surface: 'waiting_room' },
  { provider: 'carbon', surface: 'cli_chat' },
]
const GATE_CODES = new Set([
  'waiting_room_required',
  'session_expired',
  'session_superseded',
  'session_model_mismatch',
])

/**
 * Pacific-day date key (YYYY-MM-DD) for the daily streak check-in gate.
 * Hour 24 is normalized (hour12:false can yield '24' at midnight in ICU).
 */
function pacificDateKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: STREAK_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now)
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '0'
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** Milliseconds until the next Pacific midnight (recomputed on each call). */
function msUntilPacificMidnight(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: STREAK_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now)
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '0'
  const h = Number(get('hour')) % 24
  const m = Number(get('minute'))
  const s = Number(get('second'))
  const secondsLeft = 86_400 - (h * 3600 + m * 60 + s)
  return Math.max(STREAK_MIN_DELAY_MS, secondsLeft * 1000 + STREAK_BUFFER_MS)
}

/** Best-effort open of a URL in the default browser. */
function openBrowser(url) {
  const cmd =
    process.platform === 'win32'
      ? { command: 'cmd', args: ['/c', 'start', '', url] }
      : process.platform === 'darwin'
        ? { command: 'open', args: [url] }
        : { command: 'xdg-open', args: [url] }
  try {
    const child = spawn(cmd.command, cmd.args, {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

class Daemon {
  constructor({ config, bus, store, client }) {
    this.config = config
    this.bus = bus
    this.store = store
    this.client = client

    this.login = null // { status, loginUrl, fingerprintHash, expiresAt, startedAt, attempts }
    this.session = null // last session server response
    this.ads = {
      current: null,
      cache: [],
      cacheIndex: 0,
      impressionsFired: new Set(),
      impressionsAt: new Map(), // impUrl -> ISO timestamp of first impression
      lastFetchAt: null,
      lastFetchedCount: 0,
      provider: null,
    }
    this.chatHistory = []
    this.knownUser = null
    this.streak = { value: null, checkedAt: null }

    this._timers = new Map() // name -> timer (rescheduling replaces in place)
    this._stopped = false
  }

  // ---- public state snapshot (minus heavy logs) --------------------------

  publicState() {
    const session = this.session
    // Never leak the poll timer (a live Timeout object) into serialized state:
    // spread it out of the object entirely so no serialization path can see it.
    let login = null
    if (this.login) {
      login = { ...this.login }
      delete login.pollTimer
    }
    return {
      login,
      session: session
        ? {
            status: session.status,
            instanceId: session.instanceId,
            model: session.model,
            admittedAt: session.admittedAt,
            expiresAt: session.expiresAt,
            remainingMs: session.remainingMs,
            rateLimit: session.rateLimit,
          }
        : null,
      ads: {
        current: this.ads.current,
        provider: this.ads.provider,
        lastFetchAt: this.ads.lastFetchAt,
        fetchedCount: this.ads.lastFetchedCount,
        impressionsFiredCount: this.ads.impressionsFired.size,
        impressionsAt: Object.fromEntries(this.ads.impressionsAt),
      },
      chatHistoryLength: this.chatHistory.length,
      streak: {
        value: this.streak.value,
        checkedAt: this.streak.checkedAt,
        checkedToday: this.store.streakCheckDate === pacificDateKey(),
      },
    }
  }

  emitState() {
    this.bus.emit('event', { type: 'state', state: this.publicState() })
  }

  emitAuth() {
    this.bus.emit('event', { type: 'auth', user: this.safeUser() })
  }

  safeUser() {
    const u = this.store.user
    if (!u) return null
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      tokenSource: this._tokenSource,
    }
  }

  // ---- lifecycle ---------------------------------------------------------

  async start() {
    const bus = this.bus
    bus.info('Freebuff port daemon starting')

    // Token resolution: our state → official CLI credentials → env var.
    let token = this.store.user?.authToken || null
    this._tokenSource = token ? 'freebuff-adapter state' : null
    if (!token) {
      const official = this.store.officialUser
      if (official) {
        this._officialUser = official
        token = official.authToken
        this._tokenSource = 'official CLI credentials (~/.config/manicode)'
        bus.info('Using credentials from official CLI credentials file', {
          email: official.email,
        })
      }
    }
    if (!token && process.env.CODEBUFF_API_KEY) {
      token = process.env.CODEBUFF_API_KEY
      this._tokenSource = 'CODEBUFF_API_KEY env'
    }
    this._token = token

    if (token) {
      this.knownUser = {
        name: this.store.user?.name,
        email: this.store.user?.email || this._officialUser?.email,
      }
      const task = bus.task('startup.validate', 'validate token')
      const { ok, status } = await this.client.me(token).catch((err) => ({
        ok: false,
        status: err?.status,
      }))
      if (ok) {
        bus.info('Token validated', { via: this._tokenSource })
        bus.report('token_validated', {
          via: this._tokenSource,
          email: this.knownUser?.email,
        })
      } else {
        bus.warn(
          `Token did not validate (HTTP ${status ?? 'network error'}) — login again if requests start failing`,
          { via: this._tokenSource },
        )
        bus.report('token_invalid', { status })
      }
      task.done()

      await this.probeSession()
      if (this.store.settings.autoAdmit) {
        await this.admitSession(this.store.settings.model, { quiet: true })
      }
      // Kick off the first ad rotation right away (the UI is the ad viewer).
      this.rotateAds().catch(() => {})
    } else {
      bus.info('Not logged in — use the UI "Log in" button to start the device-code flow')
    }

    this._setInterval('sessionPoll', SESSION_POLL_MS, () => this.pollSession())
    this._setAdRotationInterval()
    // Re-check the streak at the next Pacific midnight so a long-running
    // daemon keeps the daily check-in even without a login/session event.
    this._scheduleStreakCheck()
    if (token) {
      this.maybeCheckInStreak().catch(() => {})
    }
    this.emitState()
    this.emitAuth()
  }

  _setInterval(name, ms, fn) {
    const old = this._timers.get(name)
    if (old) clearInterval(old)
    const t = setInterval(() => {
      fn().catch((err) => {
        this.bus.error(`[${name}] ${err.message}`)
      })
    }, ms)
    if (typeof t.unref === 'function') t.unref()
    this._timers.set(name, t)
    return t
  }

  /** (Re)arm the ad-rotation cadence from the current settings. */
  _setAdRotationInterval() {
    this._setInterval(
      'adRotation',
      Math.max(15_000, this.store.settings.adIntervalMs),
      () => this.rotateAds(),
    )
  }

  /** Apply a settings patch with any daemon-side effects (e.g. timer resets). */
  applySettings(patch) {
    if (patch && typeof patch.adIntervalMs === 'number') {
      this._setAdRotationInterval()
    }
  }

  async stop() {
    this._stopped = true
    for (const t of this._timers.values()) clearInterval(t)
    this._timers = new Map()
    if (this.login?.pollTimer) clearInterval(this.login.pollTimer)
    await this.releaseSession({ quiet: true })
  }

  // ---- login ------------------------------------------------------------

  async startLogin() {
    const bus = this.bus
    if (this.login && this.login.status === 'pending') {
      return { alreadyPending: true, loginUrl: this.login.loginUrl }
    }
    const fingerprintId = getFingerprintId()
    const task = bus.task('login.code', 'request login code')
    try {
      const data = await this.client.loginCode(fingerprintId)
      bus.report('login_code_requested', {
        expiresAt: data.expiresAt,
        expiresInMs: data.expiresInMs,
      })
      this.login = {
        status: 'pending',
        loginUrl: data.loginUrl,
        fingerprintHash: data.fingerprintHash,
        expiresAt: data.expiresAt,
        startedAt: new Date().toISOString(),
        attempts: 0,
        pollTimer: null,
      }
      task.done({ expiresAt: data.expiresAt })
      bus.info('Login URL generated — waiting for browser sign-in')
      const opened = openBrowser(data.loginUrl)
      if (!opened) {
        bus.warn('Could not auto-open browser; use the URL shown in the UI')
      }
      this._startLoginPolling(fingerprintId)
      this.emitState()
      return { loginUrl: data.loginUrl, opened }
    } catch (err) {
      task.fail(err)
      bus.error(`Login code request failed: ${err.message}`)
      bus.report('login_failed', { stage: 'code_request', error: err.message })
      throw err
    }
  }

  _startLoginPolling(fingerprintId) {
    if (this.login?.pollTimer) clearInterval(this.login.pollTimer)
    const started = Date.now()
    this.login.attempts = 0
    const tick = async () => {
      const login = this.login
      if (!login || login.status !== 'pending') return
      login.attempts += 1

      if (Date.now() - started > LOGIN_TIMEOUT_MS) {
        this.cancelLogin('timed out')
        return
      }
      if (Date.now() - Date.parse(login.expiresAt) > 0) {
        this.bus.warn('Login code expired — request a new one')
        this.cancelLogin('code expired')
        return
      }

      let body
      try {
        body = await this.client.loginStatus({
          fingerprintId,
          fingerprintHash: login.fingerprintHash,
          expiresAt: login.expiresAt,
        })
      } catch (err) {
        this.bus.warn(`Login status poll failed: ${err.message} — retrying`)
        return
      }
      if (body?.user && typeof body.user === 'object') {
        await this._finishLogin(body.user)
      }
    }
    this.login.pollTimer = setInterval(tick, LOGIN_POLL_MS)
    if (typeof this.login.pollTimer.unref === 'function') {
      this.login.pollTimer.unref()
    }
    const task = this.bus.task('login.poll', 'polling login status')
    this._loginPollTask = task
    const pollId = setInterval(() => {
      if (this.login?.status === 'pending') {
        task.update(`attempt ${this.login.attempts ?? '?'}`)
      }
    }, 1000)
    this._loginPollTick = pollId
    if (typeof pollId.unref === 'function') pollId.unref()
    // Run the first attempt immediately.
    tick().catch(() => {})
  }

  async _finishLogin(user) {
    const bus = this.bus
    // Guard against racing poll ticks (a slow status request can overlap the
    // next tick, and a cancelled login may still have a poll in flight): only
    // the first completion of a pending login may proceed.
    if (!this.login) return
    if (this.login?.pollTimer) clearInterval(this.login.pollTimer)
    if (this._loginPollTick) clearInterval(this._loginPollTick)
    const attempts = this.login?.attempts ?? 0
    this._loginPollTask?.done({ attempts }, `attempt ${attempts}`)
    this._loginPollTask = null
    this.login = null
    this.store.setUser(user)
    this.store.setFingerprint(null)
    this._token = user.authToken
    this._tokenSource = 'freebuff-adapter state'
    this.knownUser = { name: user.name, email: user.email }
    bus.report('login_completed', {
      email: user.email,
      name: user.name,
      id: user.id,
    })
    bus.info(`Logged in as ${user.name} (${user.email})`)
    this.emitAuth()
    this.emitState()
    if (this.store.settings.autoAdmit) {
      await this.admitSession(this.store.settings.model, { quiet: true })
    }
    // Start the ad viewer immediately after login.
    this.rotateAds().catch(() => {})
    this.maybeCheckInStreak().catch(() => {})
  }

  cancelLogin(reason = 'cancelled') {
    if (!this.login) return
    if (this.login.pollTimer) clearInterval(this.login.pollTimer)
    if (this._loginPollTick) clearInterval(this._loginPollTick)
    this._loginPollTask?.fail(reason)
    this._loginPollTask = null
    this.bus.info(`Login ${reason}`)
    this.bus.report('login_aborted', { reason })
    this.login = null
    this.emitState()
  }

  async logout() {
    const bus = this.bus
    const user = this.store.user
    try {
      if (user?.authToken) {
        await this.client.logout({
          userId: user.id,
          fingerprintId: getFingerprintId(),
          fingerprintHash: user.fingerprintHash ?? '',
        })
      }
    } catch (err) {
      bus.warn(`Logout request failed: ${err.message}`)
    }
    await this.releaseSession({ quiet: true })
    this.store.setUser(null)
    this.store.setStreakCheckDate(null)
    this._token = null
    this.knownUser = null
    this.streak = { value: null, checkedAt: null }
    bus.info('Logged out')
    bus.report('logged_out', {})
    this.emitAuth()
    this.emitState()
  }

  get token() {
    return this._token ?? null
  }

  // ---- session ----------------------------------------------------------

  get liveSession() {
    const s = this.session
    return s && (s.status === 'active' || (s.status === 'ended' && s.instanceId))
      ? s
      : null
  }

  async probeSession() {
    if (!this._token) return
    const bus = this.bus
    const task = bus.task('session.probe', 'probe session')
    try {
      const res = await this.client.sessionRequest('GET', this._token, {})
      this.session = res
      if (res.status === 'active') {
        bus.info(`Existing active session adopted (${res.model})`, {
          instanceId: res.instanceId,
          expiresAt: res.expiresAt,
        })
        bus.report('session_adopted', {
          model: res.model,
          instanceId: res.instanceId,
        })
      } else if (res.status === 'none') {
        bus.info('No active session')
      } else if (res.status === 'country_blocked' || res.status === 'banned') {
        bus.error(`Session gate: ${res.status}`)
      } else {
        bus.warn(`Session probe returned: ${res.status}`)
      }
      task.done({ status: res.status })
    } catch (err) {
      task.fail(err)
      bus.error(`Session probe failed: ${err.message}`)
    }
    this.emitState()
  }

  async admitSession(model, { quiet = false } = {}) {
    const bus = this.bus
    if (!this._token) {
      if (!quiet) bus.warn('Cannot admit session: not logged in')
      return null
    }
    const target = model || this.store.settings.model

    // Switching models on a live session requires DELETE then POST.
    const live = this.liveSession
    if (live && live.model && live.model !== target) {
      bus.info(`Releasing session on ${live.model} before switching to ${target}`)
      await this.releaseSession({ quiet: true })
    }

    const task = bus.task('session.admit', `admit session (${target})`)
    try {
      const res = await this.client.sessionRequest('POST', this._token, {
        model: target,
      })
      this.session = res
      if (res.status === 'active') {
        bus.info(`Session admitted: ${res.model}`, {
          instanceId: res.instanceId,
          expiresAt: res.expiresAt,
          remainingMs: res.remainingMs,
        })
        bus.report('session_admitted', {
          model: res.model,
          instanceId: res.instanceId,
          expiresAt: res.expiresAt,
          rateLimit: res.rateLimit,
        })
        task.done({ instanceId: res.instanceId })
      } else if (res.status === 'rate_limited') {
        task.fail(`rate limited (${res.recentCount}/${res.limit})`)
        bus.error(
          `Session quota exhausted: ${res.recentCount}/${res.limit} ${res.period}`,
          { resetAt: res.resetAt },
        )
        bus.report('session_rate_limited', {
          limit: res.limit,
          recentCount: res.recentCount,
          period: res.period,
          resetAt: res.resetAt,
        })
      } else {
        task.fail(res.status)
        bus.error(`Session admission refused: ${res.status}`)
        bus.report('session_refused', { status: res.status, body: res })
      }
    } catch (err) {
      task.fail(err)
      bus.error(`Session admission failed: ${err.message}`)
      bus.report('session_admit_failed', {
        error: err.message,
        status: err.status,
      })
      return null
    }
    this.emitState()
    return this.liveSession
  }

  async releaseSession({ quiet = false } = {}) {
    const bus = this.bus
    const live = this.liveSession
    if (!this._token || !live) return
    try {
      await this.client.sessionRequest('DELETE', this._token, {})
      bus.info('Session released')
      bus.report('session_released', {
        model: live.model,
        instanceId: live.instanceId,
      })
    } catch (err) {
      if (!quiet) bus.warn(`Session release failed: ${err.message} (server sweeps stale rows)`)
    }
    this.session = { status: 'none' }
    this.emitState()
  }

  async pollSession() {
    const live = this.liveSession
    if (!live || !this._token) return
    let res
    try {
      res = await this.client.sessionRequest('GET', this._token, {
        instanceId: live.instanceId,
      })
    } catch (err) {
      this.bus.debug(`Session poll failed: ${err.message}`)
      return
    }
    this.session = res
    if (res.status === 'active') {
      // All good; remainingMs refreshes the countdown.
      this.emitState()
      return
    }
    if (res.status === 'ended') {
      this.bus.warn('Session ended (grace window)')
      this.bus.report('session_ended', { model: live.model })
      if (this.store.settings.autoAdmit) {
        this.bus.info('Auto re-admitting session')
        await this.admitSession(this.store.settings.model)
      }
    } else if (res.status === 'superseded') {
      this.bus.warn('Session superseded by another instance')
      this.bus.report('session_superseded', {})
      if (this.store.settings.autoAdmit) {
        await this.admitSession(this.store.settings.model)
      }
    } else if (res.status === 'none') {
      this.bus.warn('Session row gone — re-admitting')
      if (this.store.settings.autoAdmit) {
        await this.admitSession(this.store.settings.model)
      }
    } else if (res.status === 'country_blocked' || res.status === 'banned') {
      this.bus.error(`Session gate: ${res.status}`)
      this.bus.report('session_gated', { status: res.status })
    }
    this.emitState()
  }

  /** Ensure a live session for `model`, admitting one if missing. */
  async ensureSession(model) {
    const live = this.liveSession
    if (live && (!model || live.model === model)) return live
    if (live && model && live.model !== model) {
      await this.releaseSession({ quiet: true })
    }
    return this.admitSession(model, { quiet: true })
  }

  // ---- streak check-in ----------------------------------------------------

  /**
   * Daily Freebuff streak check-in: `GET /api/v1/freebuff/streak`. The streak
   * is derived server-side from usage, so the "check-in" is one authed GET per
   * Pacific day. Failures are reported but never fatal (mirrors the official
   * client, which reads it on the landing screen with retry: false).
   */
  async checkInStreak() {
    if (!this._token) return this.streak
    const bus = this.bus
    const task = bus.task('streak.check', 'freebuff streak check-in')
    try {
      const body = await this.client.streak(this._token)
      const value = typeof body?.streak === 'number' ? body.streak : 0
      this.streak = { value, checkedAt: new Date().toISOString() }
      this.store.setStreakCheckDate(pacificDateKey())
      bus.report('streak_checked', {
        streak: value,
        checkedAt: this.streak.checkedAt,
      })
      bus.info(`Streak check-in: ${value}-day streak`)
      task.done({ streak: value })
    } catch (err) {
      task.fail(err)
      bus.warn(`Streak check-in failed: ${err.message}`)
      bus.report('streak_check_failed', {
        error: err.message,
        status: err.status,
      })
    }
    this.emitState()
    return this.streak
  }

  /** Check in once per Pacific day (no-op if today was already checked). */
  async maybeCheckInStreak() {
    if (!this._token) return
    if (this.store.streakCheckDate === pacificDateKey()) return
    await this.checkInStreak()
  }

  /** Arm (or re-arm) the once-per-Pacific-day check-in timer. */
  _scheduleStreakCheck() {
    const old = this._timers.get('streakCheck')
    if (old) clearTimeout(old)
    const t = setTimeout(() => {
      this.maybeCheckInStreak()
        .catch(() => {})
        .finally(() => this._scheduleStreakCheck())
    }, msUntilPacificMidnight())
    if (typeof t.unref === 'function') t.unref()
    this._timers.set('streakCheck', t)
  }

  // ---- ads --------------------------------------------------------------

  adMessages() {
    return this.chatHistory
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: String(m.content).slice(0, 2000) }))
      .slice(-10)
  }

  async reportImpression(ad) {
    const bus = this.bus
    if (this.ads.impressionsFired.has(ad.impUrl)) return
    this.ads.impressionsFired.add(ad.impUrl)
    this.ads.impressionsAt.set(ad.impUrl, new Date().toISOString())

    // ZeroClick ads report to zeroclick.dev first.
    if (ad.provider === 'zeroclick' && ad.impressionIds?.length) {
      try {
        const res = await fetch(ZEROCLICK_IMPRESSIONS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: ad.impressionIds }),
          signal: AbortSignal.timeout(15_000),
        })
        if (!res.ok) {
          bus.warn(`ZeroClick impression failed: HTTP ${res.status}`)
        }
      } catch (err) {
        bus.warn(`ZeroClick impression failed: ${err.message}`)
      }
    }

    try {
      const { ok, status, body } = await this.client.reportImpression(
        this._token,
        ad.impUrl,
        'LITE',
      )
      if (ok) {
        bus.report('impression_reported', {
          title: ad.title,
          provider: ad.provider,
          creditsGranted: body?.creditsGranted ?? 0,
        })
        bus.debug(`Impression reported: ${ad.title}`)
      } else {
        bus.warn(`Impression report failed: HTTP ${status}`)
      }
    } catch (err) {
      bus.warn(`Impression report failed: ${err.message}`)
    }
  }

  async rotateAds() {
    if (!this._token) return
    if (!this.store.settings.adsEnabled) return

    const bus = this.bus
    const task = bus.task('ads.rotate', 'rotate ads')
    let result = null
    for (const cand of AD_CANDIDATES) {
      try {
        result = await this.client.fetchAds(this._token, {
          provider: cand.provider,
          surface: cand.surface,
          messages: this.adMessages(),
          sessionId: this._chatSessionId || (this._chatSessionId = randomUUID()),
        })
      } catch (err) {
        bus.debug(`Ad fetch failed (${cand.provider}/${cand.surface}): ${err.message}`)
        result = null
      }
      if (result && Array.isArray(result.ads) && result.ads.length > 0) break
      result = null
    }

    if (result && Array.isArray(result.ads) && result.ads.length > 0) {
      const ads = result.ads.map((ad) => ({
        ...ad,
        provider: result.provider ?? ad.provider ?? 'gravity',
      }))
      this._cacheAds(ads)
      this.ads.lastFetchedCount = ads.length
      // Cap what the viewer renders (and thus what counts as seen).
      this.ads.current = ads.slice(0, MAX_AD_VIEW)
      this.ads.provider = result.provider ?? ads[0].provider ?? null
      this.ads.lastFetchAt = new Date().toISOString()
      bus.report('ads_fetched', {
        count: ads.length,
        shown: this.ads.current.length,
        provider: this.ads.provider,
        titles: ads.map((a) => a.title),
      })
      bus.info(
        `Ads fetched (${ads.length}) — showing ${this.ads.current.length} in the ad viewer`,
      )
      // The UI is the ad viewer: report the impression for every ad we just
      // displayed. Dedupe by impUrl keeps re-rotations from double-reporting.
      for (const ad of this.ads.current) await this.reportImpression(ad)
      task.done({ count: ads.length })
    } else {
      // Fall back to the rotation cache, like the official client.
      const cached = this._nextCachedAds()
      if (cached) {
        this.ads.lastFetchedCount = cached.length
        this.ads.current = cached.slice(0, MAX_AD_VIEW)
        this.ads.lastFetchAt = new Date().toISOString()
        bus.debug('Using cached ads (fetch returned nothing)')
        task.done({ count: cached.length, source: 'cache' })
      } else {
        bus.warn('No ads available (fetch failed and cache empty)')
        task.fail('no ads')
      }
    }
    this.bus.emit('event', { type: 'ads', ads: this.ads.current })
    this.emitState()
  }

  _cacheAds(ads) {
    if (ads.some((a) => a.provider === 'zeroclick')) return
    const key = ads[0]?.impUrl
    if (!key) return
    if (this.ads.cache.some((set) => set[0]?.impUrl === key)) return
    this.ads.cache.push(ads)
    if (this.ads.cache.length > MAX_AD_CACHE_SIZE) this.ads.cache.shift()
  }

  _nextCachedAds() {
    if (this.ads.cache.length === 0) return null
    const set = this.ads.cache[this.ads.cacheIndex % this.ads.cache.length]
    this.ads.cacheIndex += 1
    return set
  }

  async reportClick(impUrl) {
    if (!this._token) return { ok: false, error: 'not logged in' }
    const ad = this._findAd(impUrl)
    const surface = ad ? 'cli_chat' : undefined
    const ok = await this.client.reportClick(this._token, impUrl, surface)
    if (ok) {
      this.bus.report('click_reported', { title: ad?.title ?? impUrl })
    } else {
      this.bus.warn(`Click report failed for ${impUrl}`)
    }
    return { ok }
  }

  _findAd(impUrl) {
    return (
      this.ads.current?.find((a) => a.impUrl === impUrl) ??
      this.ads.cache.flat().find((a) => a.impUrl === impUrl) ??
      null
    )
  }

  // ---- chat proxy support -----------------------------------------------

  /**
   * Handles one proxied chat request: ensure session, inject metadata,
   * forward upstream, handle session-gate rejections by re-admitting once.
   * Returns { res, meta } where res is the upstream fetch Response (streamable).
   */
  async proxyChat(body) {
    const bus = this.bus
    if (!this._token) {
      const err = new Error('Not logged in. Run the device-code login from the UI first.')
      err.status = 401
      throw err
    }
    const model = typeof body.model === 'string' ? body.model : this.store.settings.model
    if (!MODELS.some((m) => m.id === model)) {
      const err = new Error(`Unsupported model: ${model}`)
      err.status = 400
      throw err
    }

    const clientId = this._chatSessionId || (this._chatSessionId = randomUUID())

    const session = await this.ensureSession(model)
    if (!session || !session.instanceId) {
      const err = new Error(
        `No live session (${session?.status ?? 'none'}) — admission was refused`,
      )
      err.status = 409
      throw err
    }

    // The chat gate requires a server-side run: start one and send the id as
    // top-level codebuff_metadata.run_id (the nested providerOptions shape is
    // no longer read by the backend; a locally-generated id gets rejected).
    const runId = await this._startRun(model)
    if (!runId) {
      const err = new Error(
        'Failed to start an agent run upstream - chat refused (runId required)',
      )
      err.status = 502
      throw err
    }

    const injected = {
      ...body,
      // The free-mode gate requires messages[0] to be a system message
      // opening with a canonical freebuff root prompt at byte 0; inject ours
      // when the caller's own messages don't already qualify.
      messages: withCanonicalSystemPrompt(body.messages),
      codebuff_metadata: {
        // Caller-supplied keys go first so they can't override the reserved
        // identifiers the server trusts (mirrors the SDK).
        ...(body.codebuff_metadata ?? {}),
        freebuff_instance_id: session.instanceId,
        run_id: runId,
        client_id: clientId,
        cost_mode: 'free',
      },
      providerOptions: {
        ...(body.providerOptions ?? {}),
        codebuff: {
          ...(body.providerOptions?.codebuff ?? {}),
          codebuff_metadata: {
            // Caller-supplied keys go first so they can't override the
            // reserved identifiers the server trusts (mirrors the SDK).
            ...(body.providerOptions?.codebuff?.codebuff_metadata ?? {}),
            freebuff_instance_id: session.instanceId,
            run_id: runId,
            client_id: clientId,
            cost_mode: 'free',
          },
          provider: { order: [], allow_fallbacks: true },
        },
      },
    }

    // Record the messages for ad targeting (user/assistant only).
    if (Array.isArray(body.messages)) {
      for (const m of body.messages) {
        if (m && (m.role === 'user' || m.role === 'assistant')) {
          const content = typeof m.content === 'string' ? m.content : ''
          if (content) {
            this.chatHistory.push({ role: m.role, content })
            if (this.chatHistory.length > 30) this.chatHistory.shift()
          }
        }
      }
    }

    let res = await this.client.chat(this._token, injected)
    let gate = await this._maybeGate(res)

    // Defensive: the server's free_mode_cli_required gate is normally satisfied
    // by the canonical system prompt injected above. If it still fires (e.g. the
    // server adds a new check), pass the response through but surface a readable
    // report so the failure is explainable in the UI.
    if (!gate && res.status === 403) {
      const text = await res.text().catch(() => '')
      if (text.includes('free_mode_cli_required')) {
        bus.error(
          'Chat refused upstream: free-mode gate still blocked (free_mode_cli_required) — the server may require a newer CLI signal',
        )
        bus.report('chat_cli_required', { status: 403 })
      }
      return {
        res: new Response(text, { status: res.status, headers: res.headers }),
        meta: {
          model,
          runId,
          instanceId: session.instanceId,
          gateRetried: false,
        },
      }
    }

    // A rejection we inspected but that is not a session gate (or a 409 with
    // an unparseable body) must pass through untouched — `res` is already
    // consumed, so hand back the rebuilt response.
    if (gate?.passThrough) {
      return {
        res: gate.passThrough,
        meta: {
          model,
          runId,
          instanceId: session.instanceId,
          gateRetried: false,
        },
      }
    }

    // Session gate rejection: release + re-admit + retry once.
    if (gate) {
      bus.warn(
        `Chat gate rejected: ${gate.code} (HTTP ${gate.status}) — re-admitting session and retrying`,
      )
      bus.report('gate_rejection', {
        code: gate.code,
        status: gate.status,
        readmitted: true,
      })
      await this.releaseSession({ quiet: true })
      const re = await this.admitSession(model, { quiet: true })
      if (re && re.instanceId) {
        injected.codebuff_metadata.freebuff_instance_id = re.instanceId
        injected.providerOptions.codebuff.codebuff_metadata.freebuff_instance_id =
          re.instanceId
        // The old run may have been torn down with the dead session; start a
        // fresh one for the retry.
        const runId2 = await this._startRun(model)
        if (runId2) injected.codebuff_metadata.run_id = runId2
        res = await this.client.chat(this._token, injected)
        const gate2 = await this._maybeGate(res)
        return {
          res,
          meta: {
            model,
            runId,
            instanceId: re.instanceId,
            gateRetried: true,
            gate: gate.code,
            gateStatus: gate.status,
            gateRetryStillBlocked: Boolean(gate2),
          },
        }
      }
      // Re-admission failed; surface the gate error to the client.
      return this._errorResponse(res, gate)
    }

    return {
      res,
      meta: {
        model,
        runId,
        instanceId: session.instanceId,
        gateRetried: false,
      },
    }
  }

  /** Start an agent run upstream (best-effort); null on failure. */
  async _startRun(model) {
    try {
      return await this.client.startRun(this._token, {
        agentId: AGENT_ID_BY_MODEL[model] ?? DEFAULT_AGENT_ID,
        userId: this.store.user?.id,
      })
    } catch (err) {
      this.bus.error(`Agent run start failed: ${err.message}`)
      return null
    }
  }

  /**
   * Inspect a chat response for a session-gate rejection without consuming the
   * body of healthy responses. Returns null when the response should pass
   * through untouched; otherwise returns { code, status, text } and leaves `res`
   * consumed (caller must synthesize a new response). A 409 that is not a
   * session gate is also inspected (its body is consumed) but is returned as
   * { passThrough: Response } rebuilt from the captured body so the caller can
   * forward it byte-for-byte.
   */
  async _maybeGate(res) {
    if (res.status !== 428 && res.status !== 409 && res.status !== 410) {
      return null
    }
    const text = await res.text().catch(() => '')
    let code
    try {
      const body = JSON.parse(text)
      if (typeof body.error === 'string') code = body.error
      else if (typeof body.error?.code === 'string') code = body.error.code
      else if (typeof body.code === 'string') code = body.code
    } catch {
      code = undefined
    }
    if (res.status === 428 || res.status === 410) {
      return { code: code ?? 'session_gate', status: res.status, text }
    }
    if (code && GATE_CODES.has(code)) {
      return { code, status: res.status, text }
    }
    // A 409 that is not a session gate must pass through with its body intact.
    // `res` is already consumed by the inspection above, so rebuild it.
    return {
      passThrough: new Response(text, {
        status: res.status,
        headers: res.headers,
      }),
    }
  }

  _errorResponse(res, gate) {
    let body = gate.text || JSON.stringify({
      error: {
        message: `Session gate ${gate.code} (HTTP ${gate.status}) and re-admission failed`,
        type: 'server_error',
        code: gate.code,
      },
    })
    const headers = new Headers()
    headers.set('content-type', 'application/json')
    const retryAfter = res.headers.get('retry-after')
    if (retryAfter) headers.set('retry-after', retryAfter)
    return {
      res: new Response(body, { status: gate.status, headers }),
      meta: { gate: gate.code, gateStatus: gate.status },
    }
  }
}

module.exports = { Daemon, GATE_CODES, pacificDateKey }
