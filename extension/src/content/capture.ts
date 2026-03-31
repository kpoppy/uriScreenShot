import type { CaptureResult } from '../types'

const SCROLL_DELAY_MS = 120

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function requestViewportCapture(): Promise<string> {
  const response = await chrome.runtime.sendMessage({ type: 'CAPTURE_VIEWPORT_RAW' })
  if (response.error) throw new Error(response.error)
  return response.dataUrl as string
}

async function loadImageBitmap(dataUrl: string): Promise<ImageBitmap> {
  const blob = await (await fetch(dataUrl)).blob()
  return createImageBitmap(blob)
}

// ─── 전체 페이지 스크롤 캡처 ─────────────────────────────────────────────────
async function captureFullPage(): Promise<CaptureResult> {
  const totalHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)
  const totalWidth = Math.max(document.body.scrollWidth, document.documentElement.scrollWidth)
  const viewH = window.innerHeight
  const originalScrollY = window.scrollY
  const originalScrollX = window.scrollX

  const canvas = new OffscreenCanvas(totalWidth, totalHeight)
  const ctx = canvas.getContext('2d')!

  let y = 0
  while (y < totalHeight) {
    window.scrollTo(0, y)
    await delay(SCROLL_DELAY_MS)

    const dataUrl = await requestViewportCapture()
    const img = await loadImageBitmap(dataUrl)
    ctx.drawImage(img, 0, y)
    img.close()

    y += viewH
  }

  // 스크롤 원복
  window.scrollTo(originalScrollX, originalScrollY)

  const blob = await canvas.convertToBlob({ type: 'image/png' })
  const reader = new FileReader()
  const resultDataUrl = await new Promise<string>((resolve, reject) => {
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })

  return { dataUrl: resultDataUrl, width: totalWidth, height: totalHeight }
}

// ─── 메시지 수신 ─────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'PING') {
    sendResponse({ ok: true })
    return false
  }
  if (message.type === 'DO_CAPTURE_FULL_PAGE') {
    captureFullPage()
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ error: String(err) }))
    return true
  }
  return false
})

console.log('[uriScreenShot] Content capture ready')
