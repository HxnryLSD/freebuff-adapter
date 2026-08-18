'use strict'

const os = require('node:os')

/**
 * Typed client for the Freebuff API, matching the official client's wire
 * contract (see findings/API-REFERENCE.md):
 *
 *   POST {base}/api/auth/cli/code                 device-code login
 *   GET  {base}/api/auth/cli/status               poll login
 *   POST {base}/api/auth/cli/logout
 *   GET  {app}/api/v1/me                          token validation
 *   GET/POST/DELETE {app}/api/v1/freebuff/session  session lifecycle
 *   POST {app}/api/v1/agent-runs                  start a run (chat gate requires run_id)
 *   GET  {app}/api/v1/freebuff/streak             daily streak check-in (once per Pacific day)
 *   POST {app}/api/v1/ads                         fetch ads
 *   POST {app}/api/v1/ads/impression              report an impression
 *   POST {app}/api/v1/ads/click                   report a click
 *   POST {chatBase}/api/v1/chat/completions       OpenAI-compatible LLM call
 *
 * Prod split: freebuff.com only hosts the /api/auth/cli/* login endpoints;
 * the API surface (me, session, ads, usage) lives on www.codebuff.com
 * (codebuff.com 307-redirects there). Custom single-host backends (tests,
 * mock, self-hosted) serve every surface from one origin.
 *
 * Retry policy mirrors the client: 30 s timeout, 3 retries, exponential
 * backoff + jitter on 408/429/500/502/503/504 and network errors.
 */

const ADAPTER_VERSION = '0.1.1'

const SDK_UA = 'ai-sdk/openai-compatible/1.0.0/codebuff'

const AD_CHROME_VERSION = '124.0.0.0'
const AD_USER_AGENTS = {
  darwin: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${AD_CHROME_VERSION} Safari/537.36`,
  win32: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${AD_CHROME_VERSION} Safari/537.36`,
  linux: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${AD_CHROME_VERSION} Safari/537.36`,
}

class FreebuffError extends Error {
  constructor(message, { status, code, retryAfterMs, body } = {}) {
    super(message)
    this.name = 'FreebuffError'
    this.status = status
    this.code = code
    this.retryAfterMs = retryAfterMs
    this.body = body
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function jitter(baseMs) {
  return Math.round(baseMs * (0.5 + Math.random()))
}

function parseRetryAfterMs(value) {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000)
  const dateMs = Date.parse(value)
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : undefined
}

function browserUserAgent() {
  return AD_USER_AGENTS[process.platform] ?? AD_USER_AGENTS.linux
}

function deviceInfo() {
  const platformToOs = { darwin: 'macos', win32: 'windows', linux: 'linux' }
  const osName = platformToOs[process.platform] ?? 'linux'
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const locale = Intl.DateTimeFormat().resolvedOptions().locale || 'en-US'
  return { os: osName, timezone: tz, locale }
}

class FreebuffClient {
  constructor({ baseUrl, appUrl, chatBaseUrl, bus }) {
    this.baseUrl = (baseUrl || 'https://freebuff.com').replace(/\/$/, '')
    // The app/API surface (me, session, ads, usage) is served from
    // www.codebuff.com in production; freebuff.com only hosts the
    // /api/auth/cli/* login endpoints. A custom single-host backend (tests,
    // mock, self-hosted) serves every surface from one origin.
    this.appUrl = (appUrl || this._defaultAppUrl(baseUrl)).replace(/\/$/, '')
    // Chat-completions live on the app surface too (www.codebuff.com/api/v1);
    // allow the chat base to be overridden independently.
    this.chatBaseUrl = (chatBaseUrl || this.appUrl).replace(/\/$/, '')
    this.bus = bus
  }

  _defaultAppUrl(baseUrl) {
    if (baseUrl && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(baseUrl)) {
      return baseUrl
    }
    return 'https://www.codebuff.com'
  }

  url(path) {
    return `${this.baseUrl}${path}`
  }

  app(path) {
    return `${this.appUrl}${path}`
  }

  chatUrl(path) {
    return `${this.chatBaseUrl}${path}`
  }

  /**
   * fetch with timeout + transient retry (mirrors client: 3 retries,
   * exponential backoff with jitter on 408/429/5xx and network errors).
   */
  async fetchRetry(url, init = {}, { retries = 3, timeoutMs = 30_000 } = {}) {
    let lastErr
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      let res
      try {
        res = await fetch(url, {
          ...init,
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (err) {
        lastErr = err
        if (attempt < retries) {
          await sleep(jitter(1000 * 2 ** attempt))
          continue
        }
        throw err
      }
      const retryable =
        res.status === 408 ||
        res.status === 429 ||
        res.status >= 500
      if (retryable && attempt < retries) {
        const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'))
        await sleep(retryAfterMs ?? jitter(1000 * 2 ** attempt))
        continue
      }
      return res
    }
    throw lastErr
  }

  async fetchJson(url, init, opts) {
    const res = await this.fetchRetry(url, init, opts)
    const text = await res.text().catch(() => '')
    let body = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = null
    }
    return { res, body, text }
  }

  // ---- login -------------------------------------------------------------

  async loginCode(fingerprintId) {
    const { res, body } = await this.fetchJson(
      this.url('/api/auth/cli/code'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fingerprintId }),
      },
      { retries: 2 },
    )
    if (!res.ok) {
      throw new FreebuffError(
        `Login code request failed: HTTP ${res.status}`,
        { status: res.status, body },
      )
    }
    return body // { loginUrl, fingerprintHash, expiresAt, expiresInMs }
  }

  async loginStatus({ fingerprintId, fingerprintHash, expiresAt }) {
    const q = new URLSearchParams({
      fingerprintId,
      fingerprintHash,
      expiresAt,
    })
    const res = await this.fetchRetry(
      `${this.url('/api/auth/cli/status')}?${q.toString()}`,
      {},
      { retries: 1, timeoutMs: 15_000 },
    )
    if (res.status === 401) return { user: null }
    if (!res.ok) return { user: null }
    const body = await res.json().catch(() => ({}))
    return body // { user?: {...} } — empty until signed in
  }

  async logout({ userId, fingerprintId, fingerprintHash }) {
    const { res } = await this.fetchJson(this.url('/api/auth/cli/logout'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, fingerprintId, fingerprintHash }),
    })
    return res.ok
  }

  // ---- identity ----------------------------------------------------------

  async me(token) {
    // `name` is not a valid field — the server 400s the whole request
    // (valid: id, email, discord_id, stripe_customer_id, banned, created_at).
    const { res, body } = await this.fetchJson(
      this.app('/api/v1/me?fields=id,email'),
      { headers: { Authorization: `Bearer ${token}` } },
    )
    return { ok: res.ok, status: res.status, body }
  }

  // ---- streak ------------------------------------------------------------

  /**
   * Daily streak check-in. A plain authed GET (the streak is derived
   * server-side from usage); the official client reads it on the landing
   * screen with no retry. We keep one transient retry so a single network
   * blip doesn't forfeit the day's check-in.
   */
  async streak(token) {
    const { res, body } = await this.fetchJson(
      this.app('/api/v1/freebuff/streak'),
      { headers: { Authorization: `Bearer ${token}` } },
      { retries: 1, timeoutMs: 15_000 },
    )
    if (!res.ok) {
      throw new FreebuffError(`Streak check-in failed: HTTP ${res.status}`, {
        status: res.status,
        body,
      })
    }
    return body // { streak: number }
  }

  // ---- session -----------------------------------------------------------

  async sessionRequest(method, token, { instanceId, model } = {}) {
    const headers = { Authorization: `Bearer ${token}` }
    if (method === 'GET' && instanceId) {
      headers['x-freebuff-instance-id'] = instanceId
    }
    if (method === 'GET') headers['x-freebuff-compact-session'] = '1'
    if (method === 'POST' && model) headers['x-freebuff-model'] = model

    const { res, body, text } = await this.fetchJson(
      this.app('/api/v1/freebuff/session'),
      { method, headers },
      { retries: 1, timeoutMs: 20_000 },
    )

    if (res.status === 404) return { status: 'none' }
    if (res.status === 403 && body && (body.status === 'country_blocked' || body.status === 'banned')) {
      return body
    }
    if (res.status === 409 && method === 'POST' && body && (body.status === 'model_locked' || body.status === 'model_unavailable')) {
      return body
    }
    if (res.status === 429 && method === 'POST' && body && (body.status === 'rate_limited' || body.status === 'spend_limited' || body.status === 'ip_capped')) {
      return body
    }
    if (!res.ok) {
      let code
      try {
        const parsed = JSON.parse(text)
        if (typeof parsed.error === 'string') code = parsed.error
      } catch {
        /* non-JSON error body */
      }
      throw new FreebuffError(
        `Freebuff session ${method} failed: HTTP ${res.status} ${text.slice(0, 160)}`,
        {
          status: res.status,
          code,
          retryAfterMs: parseRetryAfterMs(res.headers.get('retry-after')),
        },
      )
    }
    return body ?? { status: 'unknown' }
  }

  // ---- agent runs --------------------------------------------------------

  /**
   * Start an agent run server-side; the returned runId must be sent as
   * `codebuff_metadata.run_id` (top-level body field) on chat requests — the
   * gate rejects requests whose run id it does not know.
   */
  async startRun(token, { agentId, userId } = {}) {
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    }
    if (userId) headers['x-freebuff-acting-user-id'] = userId
    const { res, body } = await this.fetchJson(
      this.app('/api/v1/agent-runs'),
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ action: 'START', agentId }),
      },
      { retries: 1, timeoutMs: 20_000 },
    )
    if (!res.ok) {
      throw new FreebuffError(`Agent run start failed: HTTP ${res.status}`, {
        status: res.status,
        body,
      })
    }
    return typeof body?.runId === 'string' ? body.runId : null
  }

  // ---- ads ---------------------------------------------------------------

  async fetchAds(token, { provider = 'gravity', surface, messages = [], sessionId }) {
    const { res, body } = await this.fetchJson(
      this.app('/api/v1/ads'),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'User-Agent': `Freebuff-CLI/${ADAPTER_VERSION}`,
        },
        body: JSON.stringify({
          provider,
          messages,
          sessionId,
          device: deviceInfo(),
          surface,
          userAgent: browserUserAgent(),
        }),
      },
      { retries: 2 },
    )
    if (!res.ok) {
      throw new FreebuffError(`Ads request failed: HTTP ${res.status}`, {
        status: res.status,
        body,
      })
    }
    return body // { ads: AdResponse[], provider }
  }

  async reportImpression(token, impUrl, mode = 'LITE') {
    const { res, body } = await this.fetchJson(
      this.app('/api/v1/ads/impression'),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'User-Agent': `Freebuff-CLI/${ADAPTER_VERSION}`,
        },
        body: JSON.stringify({ impUrl, mode }),
      },
      { retries: 2 },
    )
    return { ok: res.ok, status: res.status, body }
  }

  async reportClick(token, impUrl, surface) {
    const { res } = await this.fetchJson(
      this.app('/api/v1/ads/click'),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'User-Agent': `Freebuff-CLI/${ADAPTER_VERSION}`,
        },
        body: JSON.stringify({ impUrl, ...(surface ? { surface } : {}) }),
      },
      { retries: 2 },
    )
    return res.ok
  }

  // ---- chat completions --------------------------------------------------

  /**
   * Raw fetch (caller owns streaming). Headers match the official client: the
   * SDK user-agent is what the compiled freebuff binary sends on chat (ads and
   * auth use `Freebuff-CLI/<version>` instead). The free-mode gate itself is
   * the canonical system prompt, injected by the daemon before this call.
   */
  chat(token, body) {
    return fetch(this.chatUrl('/api/v1/chat/completions'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'user-agent': 'ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.25 runtime/browser',
      },
      body: JSON.stringify(body),
    })
  }
}

module.exports = {
  FreebuffClient,
  FreebuffError,
  SDK_UA,
  browserUserAgent,
  deviceInfo,
  ADAPTER_VERSION,
}
