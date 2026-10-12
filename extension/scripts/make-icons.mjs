// Draws the mascot bubble (teal circle, two dark rounded eyes) into public/icons/icon-<size>.png.
// Pure Node: the PNG is encoded by hand (zlib for IDAT, CRC32 per chunk) so the build needs no image dependencies.
// Run with: node scripts/make-icons.mjs
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'public', 'icons')
const SIZES = [16, 32, 48, 128]

const BODY = [0x5d, 0xca, 0xa5] // #5DCAA5
const EYE = [0x16, 0x2b, 0x26]
/** Samples per pixel edge; 8x8 supersampling gives smooth edges even at 16 px */
const SS = 8

// Shape in unit coordinates (0..1 across the icon).
const CIRCLE = { cx: 0.5, cy: 0.5, r: 0.47 }
const EYE_W = 0.13
const EYE_H = 0.27
const EYES = [
  { cx: 0.37, cy: 0.46 },
  { cx: 0.63, cy: 0.46 },
]

function insideCircle(x, y) {
  const dx = x - CIRCLE.cx
  const dy = y - CIRCLE.cy
  return dx * dx + dy * dy <= CIRCLE.r * CIRCLE.r
}

/** Vertical capsule: a segment with round caps, which reads as a friendly rounded eye at every size */
function insideEye(x, y) {
  const r = EYE_W / 2
  const half = EYE_H / 2 - r
  for (const e of EYES) {
    const dy = Math.max(Math.abs(y - e.cy) - half, 0)
    const dx = x - e.cx
    if (dx * dx + dy * dy <= r * r) return true
  }
  return false
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4)
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      // Accumulate premultiplied colour so partially covered edge pixels blend correctly.
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size
          const y = (py + (sy + 0.5) / SS) / size
          if (!insideCircle(x, y)) continue
          const c = insideEye(x, y) ? EYE : BODY
          r += c[0]
          g += c[1]
          b += c[2]
          a += 1
        }
      }
      const i = (py * size + px) * 4
      if (a === 0) continue
      rgba[i] = Math.round(r / a)
      rgba[i + 1] = Math.round(g / a)
      rgba[i + 2] = Math.round(b / a)
      rgba[i + 3] = Math.round((a / (SS * SS)) * 255)
    }
  }
  return rgba
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter method
  ihdr[12] = 0 // no interlace

  // Each scanline is prefixed with filter type 0 (none).
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

await mkdir(outDir, { recursive: true })
for (const size of SIZES) {
  const file = join(outDir, `icon-${size}.png`)
  await writeFile(file, encodePng(size, render(size)))
  console.log(`wrote ${file}`)
}
