// 순수 Node.js로 PNG 아이콘 생성 (외부 의존성 없음)
import { createDeflate } from 'zlib'
import { writeFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import { promisify } from 'util'
import { deflate } from 'zlib'

const deflateAsync = promisify(deflate)

const sizes = [16, 32, 48, 128]
const outDir = resolve(import.meta.dirname, '../public/icons')
mkdirSync(outDir, { recursive: true })

// PNG 파일 생성 헬퍼
function crc32(buf) {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  let crc = 0xffffffff
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const crcInput = Buffer.concat([typeBytes, data])
  const crcVal = Buffer.alloc(4)
  crcVal.writeUInt32BE(crc32(crcInput))
  return Buffer.concat([len, typeBytes, data, crcVal])
}

async function makePng(width, height, getPixel) {
  // IHDR
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 2   // color type: RGB (3 = RGB, 6 = RGBA)
  ihdr[9] = 6   // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0

  // 이미지 데이터 (filter byte + RGBA per row)
  const rawRows = []
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4)
    row[0] = 0 // no filter
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = getPixel(x, y, width, height)
      row[1 + x * 4] = r
      row[2 + x * 4] = g
      row[3 + x * 4] = b
      row[4 + x * 4] = a
    }
    rawRows.push(row)
  }
  const raw = Buffer.concat(rawRows)
  const compressed = await deflateAsync(raw, { level: 6 })

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// 카메라 아이콘 픽셀 함수
function cameraIcon(x, y, w, h) {
  const cx = w / 2, cy = h / 2
  const r = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2)
  const outerR = w / 2 - 0.5

  // 배경 원 바깥은 투명
  if (r > outerR) return [0, 0, 0, 0]

  // 파란 배경
  const bg = [74, 144, 226, 255]

  // 흰색 렌즈 테두리
  const lensOuter = w * 0.3
  const lensInner = w * 0.16

  if (r <= lensOuter && r > lensInner) return [255, 255, 255, 255]
  if (r <= lensInner) return [74, 144, 226, 255]

  return bg
}

for (const size of sizes) {
  const png = await makePng(size, size, cameraIcon)
  const out = resolve(outDir, `${size}.png`)
  writeFileSync(out, png)
  console.log(`✓ ${size}x${size} → ${out}`)
}
console.log('✅ Icons generated')
