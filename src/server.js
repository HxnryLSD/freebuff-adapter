'use strict'

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { Readable, Transform } = require('node:stream')

const { ADAPTER_VERSION } = require('./freebuff')
const { MODELS } = require('./models')
const anthropic = require('./anthropic')

const UI_FILE = path.join(__dirname, '..', 'ui', 'index.html')
const MAX_BODY = 4 * 1024 * 1024

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'content-encoding',
  'content-length',
  'host',
])

/** True when the request arrived over the loopback interface. */
function isLoopback(req) {
  const addr = req.socket?.remoteAddress || ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('Request body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function parseJsonBody(req) {
  const buf = await readBody(req)
  if (buf.length === 0) return {}
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    const err = new Error('Invalid JSON body')
    err.status = 400
    throw err
  }
}

class Server {
  constructor({ config, bus, store, daemon }) {
    this.config = config
    this.bus = bus
    this.store = store
    this.daemon = daemon
    this.clients = new Set()
    this._heartbeat = null

    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.sendError(res, err)
      })
    })

    // Fan out every bus event (logs, warnings, errors, reports, tasks, ads,
    // session/auth state) to connected SSE clients.
    this.bus.on('event', (evt) => {
      for (const client of this.clients) {
        this.writeSse(client, evt)
      }
    })
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.config.port, this.config.host, () => {
        this._heartbeat = setInterval(() => {
          for (const res of this.clients) {
            res.write(': ping\n\n')
          }
        }, 15_000)
        if (typeof this._heartbeat.unref === 'function') this._heartbeat.unref()
        resolve()
      })
    })
  }

  stop() {
    if (this._heartbeat) clearInterval(this._heartbeat)
    for (const res of this.clients) res.end()
    this.clients.clear()
    this.server.close()
  }

  sendJson(res, status, body) {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    })
    res.end(payload)
  }

  sendError(res, err) {
    const status = err?.status || err?.statusCode || 500
    this.sendJson(res, status, {
      error: {
        message: err?.message || 'Internal error',
        type: status >= 500 ? 'server_error' : 'invalid_request_error',
      },
    })
  }

  // ---- routing -----------------------------------------------------------

  async handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const p = url.pathname
    const method = req.method

    // CORS preflight for the API surfaces.
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers':
          'Content-Type,Authorization,x-api-key,anthropic-version,anthropic-beta',
      })
      res.end()
      return
    }

    if (method === 'GET' && (p === '/' || p === '/index.html')) {
      return this.serveUi(res)
    }
    if (method === 'GET' && p === '/healthz') {
      return this.sendJson(res, 200, {
        status: 'ok',
        version: ADAPTER_VERSION,
        time: new Date().toISOString(),
      })
    }
    if (method === 'GET' && p === '/api/state') {
      return this.sendJson(res, 200, this.fullState())
    }
    if (method === 'GET' && p === '/api/events') {
      return this.serveSse(res)
    }
    if (method === 'GET' && p === '/v1/models') {
      return this.sendJson(res, 200, {
        object: 'list',
        data: MODELS.map((m) => ({
          id: m.id,
          object: 'model',
          created: 0,
          owned_by: 'freebuff',
          note: m.note,
          access: m.access,
        })),
      })
    }
    if (method === 'POST' && p === '/v1/chat/completions') {
      return this.handleChat(req, res)
    }
    if (
      method === 'POST' &&
      (p === '/v1/messages' || p === '/messages')
    ) {
      return this.handleAnthropicMessages(req, res)
    }
    if (
      method === 'POST' &&
      (p === '/v1/messages/count_tokens' || p === '/messages/count_tokens')
    ) {
      return this.handleAnthropicCountTokens(req, res)
    }

    if (p.startsWith('/api/')) {
      if (!this.checkProxyKey(req)) {
        return this.sendJson(res, 401, {
          error: { message: 'Invalid proxy API key', type: 'authentication_error' },
        })
      }
      return this.handleAdmin(method, p, req, res)
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not found')
  }

  checkProxyKey(req) {
    if (!this.config.proxyKey) return true
    // The local UI and the desktop shell talk to the daemon over loopback and
    // cannot (and should not) carry the key. FREEBUFF_PROXY_KEY protects the
    // daemon when it is exposed beyond the loopback interface (HOST=0.0.0.0),
    // so only non-loopback peers are required to authenticate.
    if (isLoopback(req)) return true
    const auth = req.headers.authorization || ''
    // \S+ (not .+) keeps \s+ and the token disjoint, so the regex cannot
    // re-split the whitespace run quadratically on crafted headers (ReDoS).
    const match = /^Bearer\s+(\S+)$/.exec(auth)
    if (match && match[1] === this.config.proxyKey) return true
    // Anthropic SDKs may send the key via x-api-key instead of Bearer.
    return req.headers['x-api-key'] === this.config.proxyKey
  }

  serveUi(res) {
    let html
    try {
      html = fs.readFileSync(UI_FILE)
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end('UI file missing')
      return
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(html)
  }

  serveSse(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write(': connected\n\n')
    this.clients.add(res)
    // Send the current full state immediately so late joiners sync up.
    this.writeSse(res, {
      type: 'state',
      state: this.daemon.publicState(),
    })
    this.writeSse(res, { type: 'auth', user: this.daemon.safeUser() })
    res.on('close', () => this.clients.delete(res))
    res.on('error', () => this.clients.delete(res))
  }

  writeSse(res, payload) {
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`)
    } catch {
      // A serialization failure must never kill the stream or the caller.
    }
  }

  fullState() {
    return {
      serverTime: new Date().toISOString(),
      version: ADAPTER_VERSION,
      config: {
        host: this.config.host,
        port: this.config.port,
        baseUrl: this.config.baseUrl,
        appUrl: this.config.appUrl,
        chatBaseUrl: this.config.chatBaseUrl,
        proxyKeySet: Boolean(this.config.proxyKey),
        mock: Boolean(this.config.mock),
      },
      user: this.daemon.safeUser(),
      officialCredentials: Boolean(this.store.officialUser),
      state: this.daemon.publicState(),
      settings: this.store.settings,
      models: MODELS,
      bus: this.bus.snapshot(),
    }
  }

  // ---- admin API ---------------------------------------------------------

  async handleAdmin(method, p, req, res) {
    if (method === 'POST' && p === '/api/login') {
      const out = await this.daemon.startLogin()
      return this.sendJson(res, 200, out)
    }
    if (method === 'POST' && p === '/api/login/cancel') {
      this.daemon.cancelLogin()
      return this.sendJson(res, 200, { ok: true })
    }
    if (method === 'POST' && p === '/api/logout') {
      await this.daemon.logout()
      return this.sendJson(res, 200, { ok: true })
    }
    if (method === 'POST' && p === '/api/session/admit') {
      const body = await parseJsonBody(req)
      const session = await this.daemon.admitSession(body.model || null)
      return this.sendJson(res, 200, { ok: true, session: this.daemon.publicState().session })
    }
    if (method === 'POST' && p === '/api/session/release') {
      await this.daemon.releaseSession()
      return this.sendJson(res, 200, { ok: true })
    }
    if (method === 'POST' && p === '/api/settings') {
      const body = await parseJsonBody(req)
      const patch = {}
      if (typeof body.model === 'string') patch.model = body.model
      if (typeof body.adsEnabled === 'boolean') patch.adsEnabled = body.adsEnabled
      if (typeof body.autoAdmit === 'boolean') patch.autoAdmit = body.autoAdmit
      if (typeof body.adIntervalMs === 'number') patch.adIntervalMs = body.adIntervalMs
      this.store.updateSettings(patch)
      this.daemon.applySettings(patch)
      this.bus.info('Settings updated', patch)
      return this.sendJson(res, 200, { ok: true, settings: this.store.settings })
    }
    if (method === 'POST' && p === '/api/streak/check') {
      // Force a streak check-in now (bypasses the once-per-Pacific-day gate).
      const streak = await this.daemon.checkInStreak()
      return this.sendJson(res, 200, { ok: true, streak })
    }
    if (method === 'POST' && p === '/api/ads/refresh') {
      await this.daemon.rotateAds()
      return this.sendJson(res, 200, { ok: true })
    }
    if (method === 'POST' && p === '/api/ads/click') {
      const body = await parseJsonBody(req)
      if (!body.impUrl) {
        return this.sendJson(res, 400, { error: { message: 'impUrl required' } })
      }
      const out = await this.daemon.reportClick(body.impUrl)
      return this.sendJson(res, 200, out)
    }
    if (method === 'POST' && p === '/api/shutdown') {
      // Graceful stop (releases the Freebuff session first) — used by the
      // desktop shell and any controller. Respond before exiting.
      this.sendJson(res, 200, { ok: true })
      setImmediate(() => {
        this.daemon
          .stop()
          .catch(() => {})
          .finally(() => {
            this.stop()
            process.exit(0)
          })
      })
      return
    }
    return this.sendJson(res, 404, { error: { message: `Unknown endpoint ${method} ${p}` } })
  }

  // ---- chat proxy --------------------------------------------------------

  async handleChat(req, res) {
    let body
    try {
      body = await parseJsonBody(req)
    } catch (err) {
      return this.sendError(res, err)
    }
    if (!this.checkProxyKey(req)) {
      return this.sendJson(res, 401, {
        error: { message: 'Invalid proxy API key', type: 'authentication_error' },
      })
    }

    const startedAt = Date.now()
    const streaming = body.stream === true
    const shortRun = String(Math.random().toString(36).slice(2, 8))

    try {
      const { res: upstream, meta } = await this.daemon.proxyChat(body)

      if (!upstream.ok) {
        // Non-2xx upstream: pass through as an OpenAI-style error.
        const text = await upstream.text().catch(() => '')
        this.bus.report('chat_failed', {
          run: shortRun,
          model: meta.model,
          status: upstream.status,
          gate: meta.gate,
          error: text.slice(0, 200),
        })
        this.bus.warn(
          `Chat request failed: HTTP ${upstream.status}${meta.gate ? ` (gate: ${meta.gate})` : ''}`,
          { model: meta.model, run: shortRun },
        )
        const headers = {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          ...(upstream.headers.get('retry-after')
            ? { 'Retry-After': upstream.headers.get('retry-after') }
            : {}),
        }
        res.writeHead(upstream.status, headers)
        res.end(text || '{"error":{"message":"upstream error"}}')
        return
      }

      const usage = { input: 0, output: 0, total: 0 }
      const task = this.bus.task(`chat.${shortRun}`, `chat ${meta.model}`)
      task.update('streaming')

      const headers = {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache, no-transform',
      }
      for (const [k, v] of upstream.headers) {
        if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v
      }
      if (streaming) {
        headers['Content-Type'] = headers['Content-Type'] || 'text/event-stream; charset=utf-8'
      } else {
        headers['Content-Type'] = headers['Content-Type'] || 'application/json; charset=utf-8'
      }
      res.writeHead(upstream.status, headers)

      // Pass bytes through unchanged; tap the stream only to count chunks and
      // harvest usage from SSE data lines / the JSON body.
      const transform = new Transform({
        transform(chunk, _enc, cb) {
          this.push(chunk)
          cb()
        },
      })
      let chunkCount = 0

      const bodyStream = Readable.fromWeb(upstream.body)
      // Client hung up mid-stream: abort the upstream request so its connection
      // and the session's streamed quota are not held until the upstream ends,
      // and close out the tracked task instead of leaving it running forever.
      res.on('close', () => {
        if (res.writableEnded) return
        upstream.body?.cancel?.().catch(() => {})
        bodyStream.destroy()
        task.fail('client disconnected')
      })
      let sseBuf = ''
      bodyStream.on('data', (chunk) => {
        chunkCount += 1
        if (streaming) {
          sseBuf += chunk.toString('utf8')
          const lines = sseBuf.split('\n')
          sseBuf = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (!payload || payload === '[DONE]') continue
            try {
              const parsed = JSON.parse(payload)
              if (parsed.usage) {
                usage.input = parsed.usage.prompt_tokens ?? usage.input
                usage.output = parsed.usage.completion_tokens ?? usage.output
                usage.total = parsed.usage.total_tokens ?? usage.total
              }
            } catch {
              /* not JSON */
            }
          }
        }
      })
      bodyStream.on('end', () => {
        task.done({
          durationMs: Date.now() - startedAt,
          chunks: chunkCount,
          usage,
        })
        this.bus.report('chat_completed', {
          run: shortRun,
          model: meta.model,
          stream: streaming,
          durationMs: Date.now() - startedAt,
          status: upstream.status,
          usage,
          instanceId: meta.instanceId,
          gateRetried: meta.gateRetried,
        })
        this.bus.info(
          `Chat ${streaming ? 'stream' : 'completion'} finished (${Date.now() - startedAt} ms, ${usage.total} tokens)`,
          { model: meta.model, run: shortRun },
        )
        this.emitState()
      })
      bodyStream.on('error', (err) => {
        task.fail(err)
        this.bus.warn(`Chat stream aborted: ${err.message}`)
      })
      bodyStream.pipe(transform).pipe(res)
    } catch (err) {
      this.bus.report('chat_failed', {
        run: shortRun,
        model: body.model,
        error: err.message,
      })
      this.bus.error(`Chat proxy error: ${err.message}`)
      this.sendError(res, err)
    }
  }

  // ---- Anthropic Messages API -----------------------------------------

  sendAnthropicError(res, status, type, message) {
    this.sendJson(res, status, anthropic.anthropicErrorBody(status, type, message))
  }

  async handleAnthropicCountTokens(req, res) {
    if (!this.checkProxyKey(req)) {
      return this.sendAnthropicError(
        res,
        401,
        'authentication_error',
        'Invalid proxy API key',
      )
    }
    let body
    try {
      body = await parseJsonBody(req)
    } catch (err) {
      return this.sendAnthropicError(res, 400, 'invalid_request_error', err.message)
    }
    try {
      const inputTokens = anthropic.countAnthropicTokens(body)
      return this.sendJson(res, 200, { input_tokens: inputTokens })
    } catch (err) {
      return this.sendAnthropicError(res, 400, 'invalid_request_error', err.message)
    }
  }

  async handleAnthropicMessages(req, res) {
    let body
    try {
      body = await parseJsonBody(req)
    } catch (err) {
      return this.sendError(res, err)
    }
    if (!this.checkProxyKey(req)) {
      return this.sendAnthropicError(
        res,
        401,
        'authentication_error',
        'Invalid proxy API key',
      )
    }

    const startedAt = Date.now()
    const streaming = body.stream === true
    const shortRun = String(Math.random().toString(36).slice(2, 8))

    try {
      // Resolve the model: accept Freebuff slugs; anything else (Claude Code
      // sends its own model names) falls back to the configured default.
      const requested = anthropic.anthropicModelToOpenAI(body.model)
      let model = requested
      if (!MODELS.some((m) => m.id === model)) {
        this.bus.warn(
          `Anthropic request model "${requested}" is not a Freebuff model — using ${this.store.settings.model}`,
        )
        model = this.store.settings.model
      }
      const oai = anthropic.anthropicToOpenAI(body, {
        resolveModel: () => model,
      })
      const { res: upstream, meta } = await this.daemon.proxyChat(oai)
      const id = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`
      const inputTokens = anthropic.countAnthropicTokens({ ...body, model })

      if (!upstream.ok) {
        // Pass the upstream error through in Anthropic error shape.
        const text = await upstream.text().catch(() => '')
        this.bus.report('chat_failed', {
          run: shortRun,
          model,
          status: upstream.status,
          gate: meta.gate,
          error: text.slice(0, 200),
        })
        this.bus.warn(
          `Anthropic chat failed: HTTP ${upstream.status}${meta.gate ? ` (gate: ${meta.gate})` : ''}`,
          { model, run: shortRun },
        )
        const headers = {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          ...(upstream.headers.get('retry-after')
            ? { 'Retry-After': upstream.headers.get('retry-after') }
            : {}),
        }
        res.writeHead(upstream.status, headers)
        res.end(
          text ||
            JSON.stringify(
              anthropic.anthropicErrorBody(upstream.status, 'api_error', 'upstream error'),
            ),
        )
        return
      }

      const task = this.bus.task(`chat.${shortRun}`, `anthropic ${model}`)
      task.update('converting stream')

      if (streaming) {
        const transform = anthropic.createAnthropicStream({
          model,
          id,
          inputTokens,
          onDone: ({ stopReason, outputTokens }) => {
            task.done({
              durationMs: Date.now() - startedAt,
              stopReason,
              outputTokens,
            })
            this.bus.report('chat_completed', {
              run: shortRun,
              model,
              stream: true,
              durationMs: Date.now() - startedAt,
              status: upstream.status,
              usage: { input: inputTokens, output: outputTokens },
              instanceId: meta.instanceId,
              gateRetried: meta.gateRetried,
            })
            this.bus.info(
              `Anthropic stream finished (${Date.now() - startedAt} ms, ${outputTokens} out tokens)`,
              { model, run: shortRun },
            )
            this.emitState()
          },
        })
        res.writeHead(upstream.status, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Access-Control-Allow-Origin': '*',
        })
        // Chain web streams (pipeThrough), then wrap for the Node res.
        const stream = Readable.fromWeb(upstream.body.pipeThrough(transform))
        stream.on('error', (err) => {
          task.fail(err)
          this.bus.warn(`Anthropic stream aborted: ${err.message}`)
        })
        // Client hung up mid-stream: abort the upstream request too, and close
        // out the tracked task instead of leaving it running forever.
        res.on('close', () => {
          if (res.writableEnded) return
          upstream.body?.cancel?.().catch(() => {})
          stream.destroy()
          task.fail('client disconnected')
        })
        stream.pipe(res)
        return
      }

      // Non-streaming.
      const oaiJson = await upstream.json().catch(() => null)
      if (!oaiJson) {
        task.fail('empty upstream response')
        return this.sendAnthropicError(res, 502, 'api_error', 'Empty upstream response')
      }
      const response = anthropic.openaiToAnthropicResponse(oaiJson, model)
      const usage = oaiJson.usage || {}
      task.done({
        durationMs: Date.now() - startedAt,
        outputTokens: usage.completion_tokens ?? 0,
      })
      this.bus.report('chat_completed', {
        run: shortRun,
        model,
        stream: false,
        durationMs: Date.now() - startedAt,
        status: upstream.status,
        usage: {
          input: usage.prompt_tokens ?? inputTokens,
          output: usage.completion_tokens ?? 0,
        },
        instanceId: meta.instanceId,
        gateRetried: meta.gateRetried,
      })
      this.bus.info(
        `Anthropic completion finished (${Date.now() - startedAt} ms)`,
        { model, run: shortRun },
      )
      return this.sendJson(res, 200, response)
    } catch (err) {
      this.bus.report('chat_failed', {
        run: shortRun,
        model: body.model,
        error: err.message,
      })
      this.bus.error(`Anthropic proxy error: ${err.message}`)
      return this.sendAnthropicError(
        res,
        err.status || 500,
        err.status && err.status < 500 ? 'invalid_request_error' : 'api_error',
        err.message,
      )
    }
  }

  emitState() {
    this.daemon.emitState()
  }
}

module.exports = { Server }
