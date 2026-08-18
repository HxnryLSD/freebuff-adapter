'use strict'

/**
 * Deterministic device fingerprint, mirroring the official CLI
 * (cli/src/utils/fingerprint.ts). The official client hashes hardware
 * identifiers into `enhanced-<sha256(base64url)>` and falls back to a random
 * `codebuff-cli-<rand>` id when the enhanced path can't gather enough machine
 * data. We do the same with zero dependencies (node:os only).
 */

const { createHash, randomBytes } = require('node:crypto')
const os = require('node:os')

let cached = null

function collectMachineSignals() {
  const cpus = os.cpus()
  const ifaces = os.networkInterfaces()

  const macAddresses = Object.values(ifaces)
    .flat()
    .filter(
      (iface) =>
        iface &&
        !iface.internal &&
        iface.mac &&
        iface.mac !== '00:00:00:00:00:00',
    )
    .map((iface) => iface.mac)
    .sort()

  return {
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpus[0]?.model ?? '',
    cpuCount: cpus.length,
    macAddresses,
    interfaceCount: Object.keys(ifaces).length,
    nodeVersion: process.version,
    fingerprintVersion: '2.0',
  }
}

function calculateEnhancedFingerprint() {
  const signals = collectMachineSignals()
  // The enhanced fingerprint needs a real machine identity; without a
  // hostname and at least one hardware MAC it's not distinctive enough.
  if (!signals.hostname || signals.macAddresses.length === 0) {
    throw new Error('Not enough machine signals for enhanced fingerprint')
  }
  const json = JSON.stringify(signals)
  const hash = createHash('sha256').update(json).digest('base64url')
  return `enhanced-${hash}`
}

function calculateLegacyFingerprint() {
  const suffix = randomBytes(6).toString('base64url').substring(0, 8)
  return `codebuff-cli-${suffix}`
}

/** Returns the process-wide fingerprint id, cached for the daemon lifetime. */
function getFingerprintId() {
  if (cached) return cached
  try {
    cached = calculateEnhancedFingerprint()
  } catch {
    cached = calculateLegacyFingerprint()
  }
  return cached
}

module.exports = { getFingerprintId }
