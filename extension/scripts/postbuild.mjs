import { copyFileSync, cpSync, existsSync, mkdirSync } from 'fs'
import { resolve } from 'path'

const dist = resolve(import.meta.dirname, '../dist')

// HTML 파일을 올바른 위치로 이동
const htmlFiles = [
  ['src/popup/popup.html', 'popup/popup.html'],
  ['src/editor/editor.html', 'editor/editor.html'],
  ['src/options/options.html', 'options/options.html'],
]

for (const [from, to] of htmlFiles) {
  const src = resolve(dist, from)
  const dest = resolve(dist, to)
  if (existsSync(src)) {
    mkdirSync(resolve(dist, to.split('/')[0]), { recursive: true })
    copyFileSync(src, dest)
    console.log(`✓ ${from} → ${to}`)
  }
}

// manifest.json 복사
copyFileSync(
  resolve(import.meta.dirname, '../manifest.json'),
  resolve(dist, 'manifest.json')
)

// selector.css 복사 (Vite가 인라인 처리하므로 소스에서 직접 복사)
const cssDest = resolve(dist, 'content/selector.css')
const cssSrcFile = resolve(import.meta.dirname, '../src/content/selector.css')
mkdirSync(resolve(dist, 'content'), { recursive: true })
copyFileSync(cssSrcFile, cssDest)
console.log('✓ selector.css copied')

// 아이콘 복사
const iconsSrc = resolve(import.meta.dirname, '../public/icons')
if (existsSync(iconsSrc)) {
  cpSync(iconsSrc, resolve(dist, 'icons'), { recursive: true })
  console.log('✓ icons copied')
}

console.log('✅ Postbuild complete')
