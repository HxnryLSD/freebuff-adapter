'use strict'

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

/**
 * Monochrome app icon (generated at build/runtime — no binary assets needed).
 * The design: a terminal prompt with a right-pointing chevron and a cursor
 * bar, inside a thin frame, white on near-black.
 *
 * Used both at runtime by the shell (main.js) and as the pre-dist step that
 * materializes `icon.png` before electron-builder packages it.
 */

function ensureIcon(filePath = path.join(__dirname, 'icon.png')) {
  if (fs.existsSync(filePath)) return
  try {
    const S = 256
    const px = Buffer.alloc(S * S * 3) // RGB
    const bg = [10, 10, 10]
    const fg = [242, 242, 242]
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        let c = bg
        const frame = x >= 10 && x < 16 || x >= 240 && x < 246 || y >= 10 && y < 16 || y >= 240 && y < 246
        if (frame) c = fg
        // terminal prompt: right-pointing chevron + cursor bar
        if (!frame) {
          if (y >= 96 && y <= 160) {
            const xRight = 150 - Math.round(90 * (Math.abs(y - 128) / 32))
            if (x >= 60 && x <= xRight) c = fg
          }
          if (y >= 172 && y <= 182 && x >= 60 && x <= 150) c = fg
        }
        const i = (y * S + x) * 3
        px[i] = c[0]
        px[i + 1] = c[1]
        px[i + 2] = c[2]
      }
    }
    const raw = Buffer.alloc(S * (1 + S * 3))
    for (let y = 0; y < S; y++) {
      raw[y * (1 + S * 3)] = 0 // filter: none
      px.copy(raw, y * (1 + S * 3) + 1, y * S * 3, (y + 1) * S * 3)
    }
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(S, 0)
    ihdr.writeUInt32BE(S, 4)
    ihdr[8] = 8 // bit depth
    ihdr[9] = 2 // color type RGB
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ])
    fs.writeFileSync(filePath, png)
  } catch {
    // Icon generation is best-effort; the default Electron icon is a fine
    // fallback and the shell must never crash over a missing icon.
  }
}

let crcTable = null
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c
    }
  }
  let crc = -1
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

module.exports = { ensureIcon }

// Standalone: `node icon.js [out.png]` — the pre-dist step.
if (require.main === module) {
  const out = process.argv[2] || path.join(__dirname, 'icon.png')
  ensureIcon(out)
  console.log('icon ready:', out)
}
