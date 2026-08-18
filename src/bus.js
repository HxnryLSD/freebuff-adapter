'use strict'

const { EventEmitter } = require('node:events')

/**
 * Central event bus for the daemon. Keeps ring-buffered collections that the
 * UI renders (logs, warnings, errors, structured reports, and tracked tasks)
 * and emits every mutation so the SSE stream can push deltas to the page.
 */

const CAP = {
  logs: 600,
  errors: 200,
  warnings: 200,
  reports: 200,
  tasks: 100,
}

function ringPush(arr, item, cap) {
  arr.push(item)
  if (arr.length > cap) arr.splice(0, arr.length - cap)
}

class Bus extends EventEmitter {
  constructor() {
    super()
    this.logs = []
    this.errors = []
    this.warnings = []
    this.reports = []
    this.tasks = new Map() // id -> task record (ordered by start)
    this._seq = 0
    this._taskOrder = []
  }

  _next() {
    this._seq += 1
    return this._seq
  }

  now() {
    return new Date().toISOString()
  }

  /**
   * @param {'debug'|'info'|'warn'|'error'} level
   * @param {string} message
   * @param {object} [data]
   */
  log(level, message, data = {}) {
    const entry = {
      id: this._next(),
      ts: this.now(),
      level,
      message,
      data,
    }
    if (level === 'error') {
      ringPush(this.errors, entry, CAP.errors)
      ringPush(this.logs, entry, CAP.logs)
      this.emit('event', { type: 'error', entry })
    } else if (level === 'warn') {
      ringPush(this.warnings, entry, CAP.warnings)
      ringPush(this.logs, entry, CAP.logs)
      this.emit('event', { type: 'warning', entry })
    } else {
      ringPush(this.logs, entry, CAP.logs)
      this.emit('event', { type: 'log', entry })
    }
  }

  debug(message, data) {
    this.log('debug', message, data)
  }

  info(message, data) {
    this.log('info', message, data)
  }

  warn(message, data) {
    this.log('warn', message, data)
  }

  error(message, data) {
    this.log('error', message, data)
  }

  /** A structured, completed record of something that happened (impression
   *  reported, session admitted, chat completed, ...). */
  report(name, data = {}) {
    const entry = {
      id: this._next(),
      ts: this.now(),
      name,
      ...data,
    }
    ringPush(this.reports, entry, CAP.reports)
    this.emit('event', { type: 'report', entry })
    return entry
  }

  /** Start a tracked task. Returns a handle used to update/finish it. */
  task(id, name) {
    const record = {
      id,
      name,
      status: 'running',
      startedAt: this.now(),
      endedAt: null,
      detail: null,
      result: null,
      error: null,
    }
    this.tasks.set(id, record)
    this._taskOrder.push(id)
    while (this._taskOrder.length > CAP.tasks) {
      const old = this._taskOrder.shift()
      this.tasks.delete(old)
    }
    this._emitTask(record)
    return {
      update: (detail) => {
        const cur = this.tasks.get(id)
        if (!cur) return
        cur.detail = detail
        this._emitTask(cur)
      },
      done: (result, detail) => {
        const cur = this.tasks.get(id)
        if (!cur) return
        cur.status = 'done'
        cur.endedAt = this.now()
        cur.result = result ?? null
        if (detail !== undefined) cur.detail = detail
        this._emitTask(cur)
      },
      fail: (error, detail) => {
        const cur = this.tasks.get(id)
        if (!cur) return
        cur.status = 'error'
        cur.endedAt = this.now()
        cur.error = error instanceof Error ? error.message : String(error)
        if (detail !== undefined) cur.detail = detail
        this._emitTask(cur)
      },
    }
  }

  _emitTask(record) {
    this.emit('event', { type: 'task', entry: record })
  }

  snapshot() {
    return {
      seq: this._seq,
      logs: this.logs,
      errors: this.errors,
      warnings: this.warnings,
      reports: this.reports,
      tasks: [...this.tasks.values()],
    }
  }
}

module.exports = { Bus }
