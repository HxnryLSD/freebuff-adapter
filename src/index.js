#!/usr/bin/env node
'use strict'

const { Bus } = require('./bus')
const { Store } = require('./store')
const { FreebuffClient } = require('./freebuff')
const { Daemon } = require('./daemon')
const { Server } = require('./server')
const { MockUpstream } = require('./mock')
const { ADAPTER_VERSION } = require('./freebuff')

function resolvePort() {
  const raw = process.env.PORT || process.env.FREEBUFF_PORT || '8899'
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : 8899
}

function resolveConfig() {
  // Prod split: freebuff.com hosts only the /api/auth/cli/* login endpoints;
  // the API surface (me, session, ads, usage) and chat-completions live on
  // www.codebuff.com (codebuff.com 307-redirects there). Custom backends set
  // FREEBUFF_APP_URL (and FREEBUFF_CHAT_BASE_URL) explicitly.
  const baseUrl = process.env.FREEBUFF_BASE_URL || 'https://freebuff.com'
  const appUrl =
    process.env.FREEBUFF_APP_URL ||
    process.env.NEXT_PUBLIC_CODEBUFF_APP_URL ||
    process.env.CODEBUFF_APP_URL ||
    'https://www.codebuff.com'
  return {
    host: process.env.HOST || process.env.FREEBUFF_HOST || '127.0.0.1',
    port: resolvePort(),
    baseUrl,
    appUrl,
    chatBaseUrl: process.env.FREEBUFF_CHAT_BASE_URL || appUrl,
    proxyKey: process.env.FREEBUFF_PROXY_KEY || '',
    mock: process.env.FREEBUFF_MOCK === '1',
  }
}

async function main() {
  const config = resolveConfig()
  const bus = new Bus()

  let mock = null
  if (config.mock) {
    mock = new MockUpstream()
    const mockPort = await mock.start()
    config.baseUrl = mock.base()
    config.appUrl = mock.base()
    config.chatBaseUrl = mock.base()
    bus.info(`Mock upstream listening on ${config.baseUrl}`)
  }

  const store = new Store(bus)
  const client = new FreebuffClient({
    baseUrl: config.baseUrl,
    appUrl: config.appUrl,
    chatBaseUrl: config.chatBaseUrl,
    bus,
  })
  const daemon = new Daemon({ config, bus, store, client })
  const server = new Server({ config, bus, store, daemon })

  process.on('unhandledRejection', (reason) => {
    bus.error(`Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`)
  })

  try {
    await server.start()
  } catch (err) {
    if (err?.code === 'EADDRINUSE') {
      bus.error(
        `Port ${config.port} is already in use. Set PORT=<port> to pick another one.`,
      )
      process.exit(1)
    }
    throw err
  }

  // Wire bus → daemon-side emissions (daemon emits 'state'/'auth'/'ads' via
  // bus events which the server fans out to SSE clients).
  await daemon.start()

  const uiUrl = `http://${config.host}:${config.port}`
  // Plain ASCII banner: box-drawing glyphs render as mojibake in Windows
  // consoles (the UTF-8 bytes get decoded with the OEM codepage).
  console.log('')
  console.log('  ================================================')
  console.log(`   FREEBUFF ADAPTER  v${ADAPTER_VERSION}`)
  console.log(`   UI + ad viewer : ${uiUrl}`)
  console.log(`   OpenAI proxy    : ${uiUrl}/v1/chat/completions`)
  console.log('  ================================================')
  console.log('')

  const shutdown = async (signal) => {
    console.log(`\n${signal} received - releasing Freebuff session and exiting`)
    await daemon.stop()
    server.stop()
    if (mock) mock.stop()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
