'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/**
 * Persisted state for the daemon, kept in ~/.config/freebuff-adapter/state.json.
 * The project was previously named "freebuff-port" — a legacy state file at
 * ~/.config/freebuff-port/state.json is read as a fallback so an existing
 * login survives the rename (writes go to the new location).
 * The official Freebuff CLI stores its own credentials at
 * ~/.config/manicode/credentials.json — we read that file (read-only) so a
 * token obtained by the official client is picked up automatically, but we
 * never write to it.
 */

const CONFIG_DIR =
  process.env.FREEBUFF_ADAPTER_CONFIG_DIR ||
  process.env.FREEBUFF_PORT_CONFIG_DIR ||
  path.join(os.homedir(), '.config', 'freebuff-adapter')

const STATE_FILE = path.join(CONFIG_DIR, 'state.json')

// Pre-rename location (project was "freebuff-port") — read-only fallback.
const LEGACY_STATE_FILE = path.join(
  os.homedir(),
  '.config',
  'freebuff-port',
  'state.json',
)

const DEFAULT_SETTINGS = {
  model: 'deepseek/deepseek-v4-pro',
  adsEnabled: true,
  autoAdmit: true,
  adIntervalMs: 60_000,
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function loadState() {
  // Prefer the current location; fall back to the legacy path only when the
  // new file doesn't exist yet, so a rename doesn't log the user out.
  const state = readJson(STATE_FILE, readJson(LEGACY_STATE_FILE, {}))
  return {
    user: state.user ?? null,
    fingerprint: state.fingerprint ?? null,
    settings: { ...DEFAULT_SETTINGS, ...(state.settings ?? {}) },
    // Last day (Pacific date key, YYYY-MM-DD) the streak was checked in.
    streakCheckDate: state.streakCheckDate ?? null,
  }
}

function saveState(state) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), {
      mode: 0o600,
    })
  } catch (err) {
    // Persistence failures must never kill the daemon; log via caller.
    throw err
  }
}

/** Official CLI credentials at ~/.config/manicode/credentials.json. */
function readOfficialCredentials() {
  const file = path.join(os.homedir(), '.config', 'manicode', 'credentials.json')
  const data = readJson(file, null)
  if (!data || typeof data !== 'object') return null
  const user = data.default
  if (user && typeof user === 'object' && typeof user.authToken === 'string') {
    return user
  }
  return null
}

class Store {
  constructor(bus) {
    this.bus = bus
    this.state = loadState()
    this._dirty = false
  }

  get user() {
    return this.state.user
  }

  get fingerprint() {
    return this.state.fingerprint
  }

  get settings() {
    return this.state.settings
  }

  get officialUser() {
    return this.official = readOfficialCredentials()
  }

  /** Pacific date key of the last daily streak check-in (null = never). */
  get streakCheckDate() {
    return this.state.streakCheckDate
  }

  setStreakCheckDate(dateKey) {
    this.state.streakCheckDate = dateKey ?? null
    this.save()
  }

  save() {
    try {
      saveState(this.state)
      this._dirty = false
    } catch (err) {
      this.bus.error(`Failed to persist state: ${err.message}`)
    }
  }

  setUser(user) {
    this.state.user = user ?? null
    this.save()
  }

  setFingerprint(fp) {
    this.state.fingerprint = fp ?? null
    this.save()
  }

  updateSettings(patch) {
    Object.assign(this.state.settings, patch)
    this.save()
  }
}

module.exports = { Store, STATE_FILE, DEFAULT_SETTINGS }
