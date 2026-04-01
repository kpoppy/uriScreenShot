import type {
  CaptureResult,
  ExtensionSettings,
  HistoryItem,
  ExtMessage,
} from '../types'
import { generateFilename, mergeSettings } from '../types'
import { create as qrCreate } from 'qrcode'
import { COMMANDS } from '../commandInfo'

const HISTORY_KEY = 'history'
const SETTINGS_KEY = 'settings'
const MAX_HISTORY = 20
const RECORDER_WINDOW_WIDTH = 860
const RECORDER_WINDOW_HEIGHT = 720

type RecorderCommand = 'start' | 'stop' | 'save' | 'reset'

let recorderWindowId: number | null = null
let recorderTabId: number | null = null
let recorderTargetTabId: number | null = null
let pendingRecorderCommand: RecorderCommand | null = null

// ─── IndexedDB 헬퍼 (대용량 이미지 → chrome.storage 한도 우회) ───────────────
const IDB_NAME = 'uriScreenShot'
const IDB_STORE = 'pending'

function openIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openIDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).put(value, key)
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error) }
  })
}

// ─── 썸네일 생성 (히스토리 저장용, quota 절약) ───────────────────────────────
async function makeThumbnail(dataUrl: string, maxSize = 280): Promise<string> {
  const blob = await (await fetch(dataUrl)).blob()
  const img = await createImageBitmap(blob)
  const scale = Math.min(maxSize / img.width, maxSize / img.height, 1)
  const w = Math.max(1, Math.round(img.width * scale))
  const h = Math.max(1, Math.round(img.height * scale))
  const canvas = new OffscreenCanvas(w, h)
  canvas.getContext('2d')!.drawImage(img, 0, 0, w, h)
  img.close()
  const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 })
  const buf = await outBlob.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return `data:image/jpeg;base64,${btoa(bin)}`
}

// ─── 설정 로드 ───────────────────────────────────────────────────────────────
async function getSettings(): Promise<ExtensionSettings> {
  const result = await chrome.storage.sync.get(SETTINGS_KEY)
  return mergeSettings(result[SETTINGS_KEY] ?? {})
}

// ─── 히스토리 관리 ───────────────────────────────────────────────────────────
async function addToHistory(item: Omit<HistoryItem, 'id' | 'timestamp'>): Promise<void> {
  const result = await chrome.storage.local.get(HISTORY_KEY)
  const history: HistoryItem[] = result[HISTORY_KEY] ?? []
  const newItem: HistoryItem = {
    ...item,
    id: crypto.randomUUID(),
    timestamp: Date.now(),
  }
  const updated = [newItem, ...history].slice(0, MAX_HISTORY)
  await chrome.storage.local.set({ [HISTORY_KEY]: updated })
}

async function getHistory(): Promise<HistoryItem[]> {
  const result = await chrome.storage.local.get(HISTORY_KEY)
  return result[HISTORY_KEY] ?? []
}

// ─── 파일 다운로드 ───────────────────────────────────────────────────────────
function downloadDataUrl(dataUrl: string, filename: string): void {
  chrome.downloads.download({ url: dataUrl, filename, saveAs: false })
}

// ─── 캡처 결과 처리 ──────────────────────────────────────────────────────────
async function handleCaptureResult(result: CaptureResult, tabUrl: string, tabTitle: string): Promise<void> {
  const settings = await getSettings()
  const filename = generateFilename(settings.filenameTemplate) + '.png'

  // 히스토리에는 썸네일만 저장 (full dataUrl → chrome.storage quota 초과 방지)
  const thumbnail = await makeThumbnail(result.dataUrl)
  await addToHistory({
    filename,
    dataUrl: thumbnail,
    width: result.width,
    height: result.height,
    url: tabUrl,
    title: tabTitle,
  })

  // 전체 이미지 + 메타데이터는 IndexedDB에 저장
  await idbSet('pendingCapture', {
    dataUrl: result.dataUrl,
    width: result.width,
    height: result.height,
    tabUrl,
    tabTitle,
  })
  await chrome.tabs.create({ url: chrome.runtime.getURL('editor/editor.html') })
}

// ─── 활성 탭 조회 헬퍼 ──────────────────────────────────────────────────────
async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (!tab?.id) throw new Error('활성 탭을 찾을 수 없습니다.')
  return tab
}

// ─── 콘텐츠 스크립트 주입 (미로드 시 자동 주입) ───────────────────────────
async function ensureContentScript(tabId: number): Promise<void> {
  try {
    // ping으로 이미 로드됐는지 확인
    await chrome.tabs.sendMessage(tabId, { type: 'PING' })
  } catch {
    // 로드 안 됐으면 scripting API로 주입
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/capture.js', 'content/selector.js'],
    })
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content/selector.css'],
    })
    // 주입 후 초기화 대기
    await new Promise(r => setTimeout(r, 100))
  }
}

function isRecordableUrl(url?: string): boolean {
  return Boolean(url && /^(https?:|file:)/.test(url))
}

function clearRecorderState() {
  recorderWindowId = null
  recorderTabId = null
  recorderTargetTabId = null
}

async function resolveTab(tab?: chrome.tabs.Tab, senderTabId?: number | null): Promise<chrome.tabs.Tab> {
  if (tab?.id) return tab
  if (senderTabId) return chrome.tabs.get(senderTabId)
  return getActiveTab()
}

async function captureFullPageFlow(tab?: chrome.tabs.Tab, senderTabId?: number | null): Promise<void> {
  const targetTab = await resolveTab(tab, senderTabId)
  const tabId = targetTab.id!

  const [{ result: dims }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      totalHeight: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
      totalWidth: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth),
      viewH: window.innerHeight,
      origX: window.scrollX,
      origY: window.scrollY,
      dpr: window.devicePixelRatio || 1,
    }),
  })
  const { totalHeight, totalWidth, viewH, origX, origY, dpr } = dims!

  const canvas = new OffscreenCanvas(Math.round(totalWidth * dpr), Math.round(totalHeight * dpr))
  const ctx = canvas.getContext('2d')!

  const [{ result: measuredHeaderH }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      let h = 0
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
        const s = window.getComputedStyle(el)
        if (s.position === 'fixed') {
          const r = el.getBoundingClientRect()
          if (r.top <= 1 && r.height > 0 && r.height < window.innerHeight * 0.35) {
            h = Math.max(h, r.bottom)
          }
        }
      }
      return Math.round(h)
    },
  })

  const headerH = Math.min(measuredHeaderH ?? 0, Math.floor(viewH / 2))
  const contentH = viewH - headerH
  const maxScroll = Math.max(0, totalHeight - viewH)
  let frame = 0

  while (true) {
    const actualScrollY = Math.min(frame * contentH, maxScroll)
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (scrollY: number) => window.scrollTo(0, scrollY),
      args: [actualScrollY],
    })
    await new Promise(r => setTimeout(r, 600))

    const dataUrl = await chrome.tabs.captureVisibleTab(targetTab.windowId!, { format: 'png' })
    const img = await createImageBitmap(await (await fetch(dataUrl)).blob())

    if (frame === 0) {
      ctx.drawImage(img, 0, 0)
    } else {
      const srcY = Math.round(headerH * dpr)
      const srcH = Math.round(contentH * dpr)
      const dstY = Math.round((actualScrollY + headerH) * dpr)
      ctx.drawImage(img, 0, srcY, img.width, srcH, 0, dstY, img.width, srcH)
    }

    img.close()
    frame++
    if (actualScrollY >= maxScroll) break
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    func: (sx: number, sy: number) => window.scrollTo(sx, sy),
    args: [origX, origY],
  })

  const outBlob = await canvas.convertToBlob({ type: 'image/png' })
  const buf = await outBlob.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  const result: CaptureResult = {
    dataUrl: `data:image/png;base64,${btoa(bin)}`,
    width: Math.round(totalWidth * dpr),
    height: Math.round(totalHeight * dpr),
  }
  await handleCaptureResult(result, targetTab.url ?? '', targetTab.title ?? '')
}

async function captureViewportFlow(tab?: chrome.tabs.Tab, senderTabId?: number | null): Promise<void> {
  const targetTab = await resolveTab(tab, senderTabId)
  const dataUrl = await chrome.tabs.captureVisibleTab(targetTab.windowId!, { format: 'png' })
  const img = await createImageBitmap(await (await fetch(dataUrl)).blob())
  const result: CaptureResult = { dataUrl, width: img.width, height: img.height }
  await handleCaptureResult(result, targetTab.url ?? '', targetTab.title ?? '')
}

async function startRegionSelectionFlow(tab?: chrome.tabs.Tab, senderTabId?: number | null): Promise<void> {
  const targetTab = await resolveTab(tab, senderTabId)
  const tabId = targetTab.id!

  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      document.getElementById('__uri_sel_overlay')?.remove()

      const overlay = document.createElement('div')
      overlay.id = '__uri_sel_overlay'
      Object.assign(overlay.style, {
        position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
        zIndex: '2147483647', cursor: 'crosshair',
        backgroundColor: 'rgba(0,0,0,0.25)',
      })

      const box = document.createElement('div')
      Object.assign(box.style, {
        position: 'fixed', border: '2px solid #4a90e2',
        backgroundColor: 'rgba(74,144,226,0.15)', display: 'none',
        pointerEvents: 'none',
      })
      overlay.appendChild(box)
      document.body.appendChild(overlay)

      let sx = 0, sy = 0, dragging = false

      overlay.addEventListener('mousedown', e => {
        e.preventDefault()
        sx = e.clientX; sy = e.clientY; dragging = true
        Object.assign(box.style, { left: sx + 'px', top: sy + 'px', width: '0', height: '0', display: 'block' })
      })

      overlay.addEventListener('mousemove', e => {
        if (!dragging) return
        const x = Math.min(e.clientX, sx), y = Math.min(e.clientY, sy)
        Object.assign(box.style, {
          left: x + 'px', top: y + 'px',
          width: Math.abs(e.clientX - sx) + 'px',
          height: Math.abs(e.clientY - sy) + 'px',
        })
      })

      overlay.addEventListener('mouseup', e => {
        dragging = false
        overlay.remove()
        const x = Math.min(e.clientX, sx), y = Math.min(e.clientY, sy)
        const w = Math.abs(e.clientX - sx), h = Math.abs(e.clientY - sy)
        if (w > 5 && h > 5) {
          chrome.runtime.sendMessage({
            type: 'CAPTURE_SELECTED',
            rect: { x, y, width: w, height: h },
            dpr: window.devicePixelRatio || 1,
          })
        }
      })

      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey) }
      }
      document.addEventListener('keydown', onKey)
    },
  })
}

async function captureSelectedFlow(
  rect: { x: number; y: number; width: number; height: number },
  dpr = 1,
  tab?: chrome.tabs.Tab,
  senderTabId?: number | null,
): Promise<void> {
  const targetTab = await resolveTab(tab, senderTabId)
  const physRect = {
    x: Math.round(rect.x * dpr),
    y: Math.round(rect.y * dpr),
    width: Math.round(rect.width * dpr),
    height: Math.round(rect.height * dpr),
  }
  const fullDataUrl = await chrome.tabs.captureVisibleTab(targetTab.windowId!, { format: 'png' })
  const cropped = await cropImage(fullDataUrl, physRect)
  await handleCaptureResult(cropped, targetTab.url ?? '', targetTab.title ?? '')
}

async function captureThumbnailFlow(tab?: chrome.tabs.Tab, senderTabId?: number | null): Promise<void> {
  const targetTab = await resolveTab(tab, senderTabId)
  const rawDataUrl = await chrome.tabs.captureVisibleTab(targetTab.windowId!, { format: 'png' })
  const tabUrl = targetTab.url ?? ''
  const tabTitle = targetTab.title ?? ''
  const composedDataUrl = await composeThumbnailWithInfo(rawDataUrl, tabUrl, tabTitle)
  const settings = await getSettings()
  const subdir = (settings.thumbSaveDir || 'site_thumb').replace(/\\/g, '/')
  const fname = urlToFilename(tabUrl)

  await idbSet('thumbDownload', {
    dataUrl: composedDataUrl,
    filename: `${fname}.png`,
    subdir,
  })
  await chrome.tabs.create({ url: chrome.runtime.getURL('editor/editor.html') + '?dl=thumb' })
}

async function startColorPickerFlow(tab?: chrome.tabs.Tab, senderTabId?: number | null): Promise<void> {
  const targetTab = await resolveTab(tab, senderTabId)
  const tabId = targetTab.id!
  const dataUrl = await chrome.tabs.captureVisibleTab(targetTab.windowId!, { format: 'png' })

  await chrome.scripting.executeScript({
    target: { tabId },
    func: (screenshotDataUrl: string) => {
      document.getElementById('__uri_eyedropper_overlay')?.remove()
      document.getElementById('__uri_eyedropper_mag')?.remove()

      const dpr = window.devicePixelRatio || 1
      const sampleCanvas = document.createElement('canvas')
      const sCtx = sampleCanvas.getContext('2d', { willReadFrequently: true })!
      const img = new Image()
      img.onload = () => {
        sampleCanvas.width = img.width
        sampleCanvas.height = img.height
        sCtx.drawImage(img, 0, 0)

        const mag = document.createElement('canvas')
        mag.id = '__uri_eyedropper_mag'
        mag.width = 128
        mag.height = 148
        Object.assign(mag.style, {
          position: 'fixed', pointerEvents: 'none', display: 'none',
          borderRadius: '10px', boxShadow: '0 3px 14px rgba(0,0,0,0.5)',
          zIndex: '2147483647', border: '2px solid #4a6fa5',
        })
        document.body.appendChild(mag)
        const mCtx = mag.getContext('2d')!
        mCtx.imageSmoothingEnabled = false

        const overlay = document.createElement('div')
        overlay.id = '__uri_eyedropper_overlay'
        Object.assign(overlay.style, {
          position: 'fixed', top: '0', left: '0',
          width: '100%', height: '100%',
          zIndex: '2147483646', cursor: 'crosshair',
        })
        document.body.appendChild(overlay)

        let currentHex = '#000000'

        overlay.addEventListener('mousemove', (e: MouseEvent) => {
          const px = Math.min(Math.round(e.clientX * dpr), sampleCanvas.width - 1)
          const py = Math.min(Math.round(e.clientY * dpr), sampleCanvas.height - 1)
          const d = sCtx.getImageData(px, py, 1, 1).data
          currentHex = '#' + [d[0], d[1], d[2]]
            .map(v => v.toString(16).padStart(2, '0')).join('')

          const half = 8
          mCtx.fillStyle = '#1a1a2e'
          mCtx.fillRect(0, 0, 128, 148)
          mCtx.drawImage(
            sampleCanvas,
            Math.max(0, px - half), Math.max(0, py - half),
            half * 2, half * 2,
            0, 0, 128, 128,
          )
          mCtx.strokeStyle = 'rgba(255,255,255,0.8)'
          mCtx.lineWidth = 1
          mCtx.beginPath()
          mCtx.moveTo(64, 0); mCtx.lineTo(64, 128)
          mCtx.moveTo(0, 64); mCtx.lineTo(128, 64)
          mCtx.stroke()
          mCtx.fillStyle = currentHex
          mCtx.fillRect(0, 128, 128, 20)
          mCtx.fillStyle = (d[0] * 0.299 + d[1] * 0.587 + d[2] * 0.114) > 128 ? '#000' : '#fff'
          mCtx.font = 'bold 11px monospace'
          mCtx.textAlign = 'center'
          mCtx.fillText(currentHex.toUpperCase(), 64, 142)

          let mx = e.clientX + 18
          let my = e.clientY - 80
          if (mx + 132 > window.innerWidth) mx = e.clientX - 148
          if (my < 0) my = e.clientY + 14
          mag.style.left = mx + 'px'
          mag.style.top = my + 'px'
          mag.style.display = 'block'
        })

        overlay.addEventListener('click', () => {
          navigator.clipboard.writeText(currentHex.toUpperCase()).catch(() => {})
          overlay.remove()
          mag.remove()
          document.removeEventListener('keydown', onKey)

          const toast = document.createElement('div')
          Object.assign(toast.style, {
            position: 'fixed', bottom: '28px', left: '50%',
            transform: 'translateX(-50%)',
            background: '#1a1a2e', color: '#fff',
            padding: '7px 18px', borderRadius: '20px',
            fontSize: '13px', fontFamily: 'monospace',
            zIndex: '2147483647', boxShadow: '0 2px 10px rgba(0,0,0,0.45)',
            borderLeft: `4px solid ${currentHex}`,
            whiteSpace: 'nowrap',
          })
          toast.textContent = `복사됨: ${currentHex.toUpperCase()}`
          document.body.appendChild(toast)
          setTimeout(() => toast.remove(), 2200)
        })

        const onKey = (e: KeyboardEvent) => {
          if (e.key === 'Escape') {
            overlay.remove()
            mag.remove()
            document.removeEventListener('keydown', onKey)
          }
        }
        document.addEventListener('keydown', onKey)
      }
      img.src = screenshotDataUrl
    },
    args: [dataUrl],
  })
}

async function openRecorderWindow(tab?: chrome.tabs.Tab, senderTabId?: number | null): Promise<void> {
  const targetTab = await resolveTab(tab, senderTabId)
  if (!targetTab?.id) throw new Error('녹화할 활성 탭을 찾을 수 없습니다.')
  if (!isRecordableUrl(targetTab.url)) {
    throw new Error('현재 페이지는 녹화할 수 없습니다. 일반 웹페이지(http/https)에서 다시 시도해 주세요.')
  }

  if (recorderWindowId != null && recorderTabId != null) {
    try {
      await chrome.windows.update(recorderWindowId, { focused: true })
      await chrome.tabs.update(recorderTabId, { active: true })
      return
    } catch {
      clearRecorderState()
    }
  }

  const url = new URL(chrome.runtime.getURL('recorder/recorder.html'))
  url.searchParams.set('tabId', String(targetTab.id))
  url.searchParams.set('title', targetTab.title ?? '')

  const created = await chrome.windows.create({
    url: url.toString(),
    type: 'popup',
    width: RECORDER_WINDOW_WIDTH,
    height: RECORDER_WINDOW_HEIGHT,
  })

  recorderWindowId = created.id ?? null
  recorderTabId = created.tabs?.[0]?.id ?? null
  recorderTargetTabId = targetTab.id
}

async function openRecorderWindowForCommand(command: RecorderCommand, tab?: chrome.tabs.Tab): Promise<void> {
  pendingRecorderCommand = command
  await openRecorderWindow(tab)
}

function dispatchRecorderCommand(command: RecorderCommand) {
  pendingRecorderCommand = command
  chrome.runtime.sendMessage({ type: 'RECORDER_COMMAND', command }).catch(() => {})
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === recorderTabId || tabId === recorderTargetTabId) {
    clearRecorderState()
  }
})

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === recorderWindowId) {
    clearRecorderState()
  }
})

chrome.commands.onCommand.addListener(async (command, tab) => {
  try {
    switch (command) {
      case COMMANDS.captureFullPage:
        await captureFullPageFlow(tab)
        break
      case COMMANDS.captureViewport:
        await captureViewportFlow(tab)
        break
      case COMMANDS.captureRegion:
        await startRegionSelectionFlow(tab)
        break
      case COMMANDS.captureThumbnail:
        await captureThumbnailFlow(tab)
        break
      case COMMANDS.colorPicker:
        await startColorPickerFlow(tab)
        break
      case COMMANDS.openRecorder:
        await openRecorderWindow(tab)
        break
      case COMMANDS.recorderStart:
        if (recorderWindowId == null) await openRecorderWindowForCommand('start', tab)
        else dispatchRecorderCommand('start')
        break
      case COMMANDS.recorderStop:
        dispatchRecorderCommand('stop')
        break
      case COMMANDS.recorderSave:
        dispatchRecorderCommand('save')
        break
      case COMMANDS.recorderReset:
        dispatchRecorderCommand('reset')
        break
      default:
        break
    }
  } catch (error) {
    console.error('[uriScreenShot] command failed:', command, error)
  }
})

// ─── 메시지 핸들러 ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener(
  (message: ExtMessage, sender, sendResponse) => {
    // 팝업에서 온 메시지는 sender.tab이 없으므로 활성 탭을 직접 조회
    const senderTabId = sender.tab?.id

    switch (message.type) {
      // Content Script에서 현재 뷰포트 캡처 요청 (항상 sender.tab 존재)
      case 'CAPTURE_VIEWPORT_RAW': {
        if (senderTabId == null) { sendResponse({ error: 'No tab' }); return true }
        chrome.tabs.captureVisibleTab(sender.tab!.windowId!, { format: 'png' })
          .then(dataUrl => sendResponse({ dataUrl }))
          .catch(err => sendResponse({ error: String(err) }))
        return true
      }

      // 전체 페이지 캡처 (scripting.executeScript 직접 방식 - content script 불필요)
      case 'CAPTURE_FULL_PAGE': {
        const doCapture = async () => {
          const tab = senderTabId
            ? await chrome.tabs.get(senderTabId)
            : await getActiveTab()
          const tabId = tab.id!

          // 페이지 크기 및 현재 스크롤 위치 조회 (DPR 포함)
          const [{ result: dims }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => ({
              totalHeight: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
              totalWidth: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth),
              viewH: window.innerHeight,
              origX: window.scrollX,
              origY: window.scrollY,
              dpr: window.devicePixelRatio || 1,
            }),
          })
          const { totalHeight, totalWidth, viewH, origX, origY, dpr } = dims!

          // 캔버스는 물리적 픽셀 크기로 생성
          const canvas = new OffscreenCanvas(Math.round(totalWidth * dpr), Math.round(totalHeight * dpr))
          const ctx = canvas.getContext('2d')!

          // 고정 헤더 높이 감지 (fixed position, 화면 상단에 붙어있는 요소)
          const [{ result: measuredHeaderH }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
              let h = 0
              for (const el of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
                const s = window.getComputedStyle(el)
                if (s.position === 'fixed') {
                  const r = el.getBoundingClientRect()
                  if (r.top <= 1 && r.height > 0 && r.height < window.innerHeight * 0.35) {
                    h = Math.max(h, r.bottom)
                  }
                }
              }
              return Math.round(h)
            },
          })
          // headerH: 헤더가 없으면 0 → 기존 동작과 동일
          const headerH = Math.min(measuredHeaderH ?? 0, Math.floor(viewH / 2))
          // 프레임당 유효 콘텐츠 높이 (헤더 제외). headerH=0이면 viewH 그대로
          const contentH = viewH - headerH

          const maxScroll = Math.max(0, totalHeight - viewH)
          let frame = 0
          while (true) {
            const actualScrollY = Math.min(frame * contentH, maxScroll)
            await chrome.scripting.executeScript({
              target: { tabId },
              func: (scrollY: number) => window.scrollTo(0, scrollY),
              args: [actualScrollY],
            })
            await new Promise(r => setTimeout(r, 600))

            const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId!, { format: 'png' })
            const img = await createImageBitmap(await (await fetch(dataUrl)).blob())

            if (frame === 0) {
              // 첫 프레임: 전체 뷰포트 그대로 (헤더 포함)
              ctx.drawImage(img, 0, 0)
            } else {
              // 이후 프레임: 헤더 부분 잘라내고 헤더 아랫부분만 합성
              // dstY = actualScrollY + headerH → 이전 프레임 끝과 정확히 맞닿음
              const srcY = Math.round(headerH * dpr)
              const srcH = Math.round(contentH * dpr)
              const dstY = Math.round((actualScrollY + headerH) * dpr)
              ctx.drawImage(img, 0, srcY, img.width, srcH, 0, dstY, img.width, srcH)
            }

            img.close()
            frame++
            if (actualScrollY >= maxScroll) break
          }

          // 스크롤 원복
          await chrome.scripting.executeScript({
            target: { tabId },
            func: (sx: number, sy: number) => window.scrollTo(sx, sy),
            args: [origX, origY],
          })

          const outBlob = await canvas.convertToBlob({ type: 'image/png' })
          const buf = await outBlob.arrayBuffer()
          const bytes = new Uint8Array(buf)
          let bin = ''
          for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
          const result: CaptureResult = {
            dataUrl: `data:image/png;base64,${btoa(bin)}`,
            width: Math.round(totalWidth * dpr),
            height: Math.round(totalHeight * dpr),
          }
          await handleCaptureResult(result, tab.url ?? '', tab.title ?? '')
          sendResponse({ ok: true })
        }
        doCapture().catch(err => sendResponse({ error: String(err) }))
        return true
      }

      // 가시 영역 캡처
      case 'CAPTURE_VIEWPORT': {
        const doCapture = async () => {
          const tab = senderTabId
            ? await chrome.tabs.get(senderTabId)
            : await getActiveTab()
          const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId!, { format: 'png' })
          const img = await createImageBitmap(await (await fetch(dataUrl)).blob())
          const result: CaptureResult = { dataUrl, width: img.width, height: img.height }
          await handleCaptureResult(result, tab.url ?? '', tab.title ?? '')
          sendResponse({ ok: true })
        }
        doCapture().catch(err => sendResponse({ error: String(err) }))
        return true
      }

      // 영역 선택 캡처 시작 (scripting.executeScript 인라인 오버레이)
      case 'CAPTURE_START_SELECT': {
        const doSelect = async () => {
          const tab = senderTabId
            ? await chrome.tabs.get(senderTabId)
            : await getActiveTab()
          const tabId = tab.id!

          await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
              document.getElementById('__uri_sel_overlay')?.remove()

              const overlay = document.createElement('div')
              overlay.id = '__uri_sel_overlay'
              Object.assign(overlay.style, {
                position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
                zIndex: '2147483647', cursor: 'crosshair',
                backgroundColor: 'rgba(0,0,0,0.25)',
              })

              const box = document.createElement('div')
              Object.assign(box.style, {
                position: 'fixed', border: '2px solid #4a90e2',
                backgroundColor: 'rgba(74,144,226,0.15)', display: 'none',
                pointerEvents: 'none',
              })
              overlay.appendChild(box)
              document.body.appendChild(overlay)

              let sx = 0, sy = 0, dragging = false

              overlay.addEventListener('mousedown', e => {
                e.preventDefault()
                sx = e.clientX; sy = e.clientY; dragging = true
                Object.assign(box.style, { left: sx + 'px', top: sy + 'px', width: '0', height: '0', display: 'block' })
              })

              overlay.addEventListener('mousemove', e => {
                if (!dragging) return
                const x = Math.min(e.clientX, sx), y = Math.min(e.clientY, sy)
                Object.assign(box.style, {
                  left: x + 'px', top: y + 'px',
                  width: Math.abs(e.clientX - sx) + 'px',
                  height: Math.abs(e.clientY - sy) + 'px',
                })
              })

              overlay.addEventListener('mouseup', e => {
                dragging = false
                overlay.remove()
                const x = Math.min(e.clientX, sx), y = Math.min(e.clientY, sy)
                const w = Math.abs(e.clientX - sx), h = Math.abs(e.clientY - sy)
                if (w > 5 && h > 5) {
                  chrome.runtime.sendMessage({
                    type: 'CAPTURE_SELECTED',
                    rect: { x, y, width: w, height: h },
                    dpr: window.devicePixelRatio || 1,
                  })
                }
              })

              // ESC 키로 취소
              const onKey = (e: KeyboardEvent) => {
                if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey) }
              }
              document.addEventListener('keydown', onKey)
            },
          })
          sendResponse({ ok: true })
        }
        doSelect().catch(err => sendResponse({ error: String(err) }))
        return true
      }

      // 선택 영역 캡처 완료 (인라인 오버레이로부터)
      case 'CAPTURE_SELECTED': {
        const { rect, dpr = 1 } = message as {
          type: string
          rect: { x: number; y: number; width: number; height: number }
          dpr?: number
        }
        // rect는 CSS 픽셀 → 물리적 픽셀로 변환
        const physRect = {
          x: Math.round(rect.x * dpr),
          y: Math.round(rect.y * dpr),
          width: Math.round(rect.width * dpr),
          height: Math.round(rect.height * dpr),
        }
        const doCapture = async () => {
          const tab = senderTabId
            ? await chrome.tabs.get(senderTabId)
            : await getActiveTab()
          const fullDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId!, { format: 'png' })
          const cropped = await cropImage(fullDataUrl, physRect)
          await handleCaptureResult(cropped, tab.url ?? '', tab.title ?? '')
          sendResponse({ ok: true })
        }
        doCapture().catch(err => sendResponse({ error: String(err) }))
        return true
      }

      // 썸네일 캡처 + 페이지 정보 합성 → 바로 저장
      case 'CAPTURE_THUMBNAIL': {
        const doThumb = async () => {
          const tab = senderTabId
            ? await chrome.tabs.get(senderTabId)
            : await getActiveTab()
          const rawDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId!, { format: 'png' })
          const tabUrl = tab.url ?? ''
          const tabTitle = tab.title ?? ''
          const composedDataUrl = await composeThumbnailWithInfo(rawDataUrl, tabUrl, tabTitle)
          const settings = await getSettings()
          const subdir = (settings.thumbSaveDir || 'site_thumb').replace(/\\/g, '/')
          const fname = urlToFilename(tabUrl)
          // SW에서 data URL + filename 조합은 Chrome MV3에서 파일명 무시됨
          // → IDB에 저장 후 에디터 페이지에서 <a download> 트리거
          await idbSet('thumbDownload', {
            dataUrl: composedDataUrl,
            filename: `${fname}.png`,
            subdir,
          })
          await chrome.tabs.create({ url: chrome.runtime.getURL('editor/editor.html') + '?dl=thumb' })
          sendResponse({ ok: true })
        }
        doThumb().catch(err => sendResponse({ error: String(err) }))
        return true
      }

      // 컬러피커 시작 (뷰포트 캡처 후 스포이드 오버레이 주입)
      case 'COLOR_PICK_START': {
        const doColorPick = async () => {
          const tab = senderTabId
            ? await chrome.tabs.get(senderTabId)
            : await getActiveTab()
          const tabId = tab.id!

          // 뷰포트 캡처 (픽셀 샘플링용)
          const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId!, { format: 'png' })

          // 스포이드 오버레이 주입
          await chrome.scripting.executeScript({
            target: { tabId },
            func: (screenshotDataUrl: string) => {
              document.getElementById('__uri_eyedropper_overlay')?.remove()
              document.getElementById('__uri_eyedropper_mag')?.remove()

              const dpr = window.devicePixelRatio || 1

              // 숨겨진 캔버스에 스크린샷 로드 (픽셀 샘플링)
              const sampleCanvas = document.createElement('canvas')
              const sCtx = sampleCanvas.getContext('2d', { willReadFrequently: true })!
              const img = new Image()
              img.onload = () => {
                sampleCanvas.width = img.width
                sampleCanvas.height = img.height
                sCtx.drawImage(img, 0, 0)

                // 돋보기 캔버스
                const mag = document.createElement('canvas')
                mag.id = '__uri_eyedropper_mag'
                mag.width = 128
                mag.height = 148
                Object.assign(mag.style, {
                  position: 'fixed', pointerEvents: 'none', display: 'none',
                  borderRadius: '10px', boxShadow: '0 3px 14px rgba(0,0,0,0.5)',
                  zIndex: '2147483647', border: '2px solid #4a6fa5',
                })
                document.body.appendChild(mag)
                const mCtx = mag.getContext('2d')!
                mCtx.imageSmoothingEnabled = false

                // 커서용 오버레이 div
                const overlay = document.createElement('div')
                overlay.id = '__uri_eyedropper_overlay'
                Object.assign(overlay.style, {
                  position: 'fixed', top: '0', left: '0',
                  width: '100%', height: '100%',
                  zIndex: '2147483646', cursor: 'crosshair',
                })
                document.body.appendChild(overlay)

                let currentHex = '#000000'

                overlay.addEventListener('mousemove', (e: MouseEvent) => {
                  const px = Math.min(Math.round(e.clientX * dpr), sampleCanvas.width - 1)
                  const py = Math.min(Math.round(e.clientY * dpr), sampleCanvas.height - 1)
                  const d = sCtx.getImageData(px, py, 1, 1).data
                  currentHex = '#' + [d[0], d[1], d[2]]
                    .map(v => v.toString(16).padStart(2, '0')).join('')

                  // 돋보기 그리기 (8x 확대, 16x16 픽셀 영역 → 128x128)
                  const zoom = 8
                  const half = 8 // 8 cells each side
                  mCtx.fillStyle = '#1a1a2e'
                  mCtx.fillRect(0, 0, 128, 148)
                  mCtx.drawImage(
                    sampleCanvas,
                    Math.max(0, px - half), Math.max(0, py - half),
                    half * 2, half * 2,
                    0, 0, 128, 128,
                  )
                  // 중앙 십자선
                  mCtx.strokeStyle = 'rgba(255,255,255,0.8)'
                  mCtx.lineWidth = 1
                  mCtx.beginPath()
                  mCtx.moveTo(64, 0); mCtx.lineTo(64, 128)
                  mCtx.moveTo(0, 64); mCtx.lineTo(128, 64)
                  mCtx.stroke()
                  // 색상 스와치
                  mCtx.fillStyle = currentHex
                  mCtx.fillRect(0, 128, 128, 20)
                  // 헥스 텍스트
                  mCtx.fillStyle = (d[0] * 0.299 + d[1] * 0.587 + d[2] * 0.114) > 128 ? '#000' : '#fff'
                  mCtx.font = 'bold 11px monospace'
                  mCtx.textAlign = 'center'
                  mCtx.fillText(currentHex.toUpperCase(), 64, 142)

                  // 돋보기 위치 (커서 오른쪽 위, 화면 경계 고려)
                  let mx = e.clientX + 18
                  let my = e.clientY - 80
                  if (mx + 132 > window.innerWidth) mx = e.clientX - 148
                  if (my < 0) my = e.clientY + 14
                  mag.style.left = mx + 'px'
                  mag.style.top = my + 'px'
                  mag.style.display = 'block'
                })

                overlay.addEventListener('click', () => {
                  navigator.clipboard.writeText(currentHex.toUpperCase()).catch(() => {})
                  overlay.remove()
                  mag.remove()
                  document.removeEventListener('keydown', onKey)

                  // 토스트 알림
                  const toast = document.createElement('div')
                  Object.assign(toast.style, {
                    position: 'fixed', bottom: '28px', left: '50%',
                    transform: 'translateX(-50%)',
                    background: '#1a1a2e', color: '#fff',
                    padding: '7px 18px', borderRadius: '20px',
                    fontSize: '13px', fontFamily: 'monospace',
                    zIndex: '2147483647', boxShadow: '0 2px 10px rgba(0,0,0,0.45)',
                    borderLeft: `4px solid ${currentHex}`,
                    whiteSpace: 'nowrap',
                  })
                  toast.textContent = `복사됨: ${currentHex.toUpperCase()}`
                  document.body.appendChild(toast)
                  setTimeout(() => toast.remove(), 2200)
                })

                const onKey = (e: KeyboardEvent) => {
                  if (e.key === 'Escape') {
                    overlay.remove()
                    mag.remove()
                    document.removeEventListener('keydown', onKey)
                  }
                }
                document.addEventListener('keydown', onKey)
              }
              img.src = screenshotDataUrl
            },
            args: [dataUrl],
          })
          sendResponse({ ok: true })
        }
        doColorPick().catch(err => sendResponse({ error: String(err) }))
        return true
      }

      // 히스토리 조회
      case 'GET_HISTORY': {
        getHistory().then(history => sendResponse({ history }))
        return true
      }

      // 설정 조회
      case 'GET_SETTINGS': {
        getSettings().then(settings => sendResponse({ settings }))
        return true
      }

      case 'REGISTER_RECORDER_WINDOW': {
        recorderTabId = sender.tab?.id ?? recorderTabId
        recorderWindowId = sender.tab?.windowId ?? recorderWindowId
        const { targetTabId } = message as { type: string; targetTabId?: number }
        if (targetTabId) recorderTargetTabId = targetTabId
        sendResponse({ pendingCommand: pendingRecorderCommand })
        return false
      }

      case 'RECORDER_COMMAND_CONSUMED': {
        pendingRecorderCommand = null
        sendResponse({ ok: true })
        return false
      }

      case 'RECORDER_STATUS': {
        const { status } = message as { type: string; status?: string }
        if (status === 'closed') clearRecorderState()
        sendResponse({ ok: true })
        return false
      }

      // 현재 탭 녹화용 stream id 발급
      case 'GET_TAB_RECORDING_STREAM_ID': {
        const { targetTabId } = message as { type: string; targetTabId: number }
        chrome.tabCapture.getMediaStreamId({ targetTabId })
          .then(streamId => sendResponse({ streamId }))
          .catch(err => sendResponse({ error: String(err) }))
        return true
      }

      // 직접 다운로드
      case 'DOWNLOAD': {
        const { dataUrl, filename } = message as { type: string; dataUrl: string; filename: string }
        downloadDataUrl(dataUrl, filename)
        sendResponse({ ok: true })
        return false
      }
    }
    return false
  }
)

// ─── 이미지 크롭 헬퍼 ────────────────────────────────────────────────────────
async function cropImage(
  dataUrl: string,
  rect: { x: number; y: number; width: number; height: number }
): Promise<CaptureResult> {
  const blob = await (await fetch(dataUrl)).blob()
  const bitmap = await createImageBitmap(blob)
  const canvas = new OffscreenCanvas(rect.width, rect.height)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height)
  const outBlob = await canvas.convertToBlob({ type: 'image/png' })
  // FileReaderSync는 Service Worker에서 사용 불가 → arrayBuffer 방식으로 변환
  const arrayBuffer = await outBlob.arrayBuffer()
  const uint8Array = new Uint8Array(arrayBuffer)
  let binary = ''
  for (let i = 0; i < uint8Array.length; i++) {
    binary += String.fromCharCode(uint8Array[i])
  }
  const base64 = btoa(binary)
  const result = `data:image/png;base64,${base64}`
  return { dataUrl: result, width: rect.width, height: rect.height }
}

// ─── URL → 파일명 변환 ───────────────────────────────────────────────────────
function urlToFilename(url: string): string {
  const name = url
    .replace(/^https?:\/\//, '')
    .replace(/^\/\//, '')
    .split('?')[0]
    .split('#')[0]
    .replace(/\/$/, '')
    .replace(/[\\/:*?"<>|\s]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  return name || 'screenshot'
}

// ─── OffscreenCanvas에 QR코드 그리기 ─────────────────────────────────────────
function drawQR(
  ctx: OffscreenCanvasRenderingContext2D,
  url: string,
  x: number, y: number, size: number,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const qr: any = qrCreate(url.slice(0, 2000), { errorCorrectionLevel: 'M' })
  const count: number = qr.modules.size
  const data: Uint8Array = qr.modules.data
  const cell = size / count
  ctx.fillStyle = '#fffef5'
  ctx.fillRect(x, y, size, size)
  ctx.fillStyle = '#1a1a1a'
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (data[r * count + c]) {
        ctx.fillRect(x + Math.floor(c * cell), y + Math.floor(r * cell), Math.ceil(cell), Math.ceil(cell))
      }
    }
  }
}

// ─── 텍스트 말줄임 ─────────────────────────────────────────────────────────
function truncSW(ctx: OffscreenCanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text
  let lo = 0, hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    ctx.measureText(text.slice(0, mid) + '…').width <= maxW ? (lo = mid) : (hi = mid - 1)
  }
  return text.slice(0, lo) + '…'
}

// ─── 썸네일 + 페이지 정보 합성 ───────────────────────────────────────────────
async function composeThumbnailWithInfo(
  rawDataUrl: string,
  tabUrl: string,
  tabTitle: string,
): Promise<string> {
  const TOTAL_W = 480
  const PAD = 14
  const BOTTOM = 96
  const IMG_W = TOTAL_W - PAD * 2
  const MAX_IMG_H = 320

  const srcBlob = await (await fetch(rawDataUrl)).blob()
  const srcImg = await createImageBitmap(srcBlob)
  const scale = Math.min(IMG_W / srcImg.width, MAX_IMG_H / srcImg.height)
  const imgW = Math.round(srcImg.width * scale)
  const imgH = Math.round(srcImg.height * scale)

  const TOTAL_H = PAD + imgH + BOTTOM
  const canvas = new OffscreenCanvas(TOTAL_W, TOTAL_H)
  const ctx = canvas.getContext('2d')!

  // 배경 (즉석사진 느낌의 따뜻한 흰색)
  ctx.fillStyle = '#fffef5'
  ctx.fillRect(0, 0, TOTAL_W, TOTAL_H)

  // 스크린샷 (중앙 정렬 + 그림자)
  ctx.shadowColor = 'rgba(0,0,0,0.22)'
  ctx.shadowBlur = 8
  ctx.shadowOffsetY = 3
  ctx.drawImage(srcImg, PAD + Math.round((IMG_W - imgW) / 2), PAD, imgW, imgH)
  srcImg.close()
  ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0

  // 구분선
  ctx.strokeStyle = '#e0ddd0'; ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(PAD, PAD + imgH + 6); ctx.lineTo(TOTAL_W - PAD, PAD + imgH + 6)
  ctx.stroke()

  // QR코드
  const QR = BOTTOM - PAD * 2
  const qrX = TOTAL_W - PAD - QR
  const qrY = PAD + imgH + Math.round((BOTTOM - QR) / 2)
  drawQR(ctx, tabUrl, qrX, qrY, QR)

  // 텍스트
  const textW = qrX - PAD * 2
  const midY = PAD + imgH + Math.round(BOTTOM / 2)
  ctx.fillStyle = '#1a1a1a'
  ctx.font = 'bold 12px sans-serif'
  ctx.fillText(truncSW(ctx, tabTitle, textW), PAD, midY - 4)
  ctx.fillStyle = '#777'
  ctx.font = '10px sans-serif'
  ctx.fillText(truncSW(ctx, tabUrl.replace(/^https?:\/\//, ''), textW), PAD, midY + 13)

  const outBlob = await canvas.convertToBlob({ type: 'image/png' })
  const buf = await outBlob.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return `data:image/png;base64,${btoa(bin)}`
}

console.log('[uriScreenShot] Service Worker ready')
