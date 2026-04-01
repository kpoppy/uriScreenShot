import { useState, useEffect, useRef, useCallback } from 'react'
import type { EditorTool } from '../types'
import { generateFilename } from '../types'

interface PendingCapture {
  dataUrl: string
  width: number
  height: number
  tabUrl?: string
  tabTitle?: string
}

type FabricCanvas = import('fabric').Canvas
type FabricObject = import('fabric').FabricObject

export default function Editor() {
  const [capture, setCapture] = useState<PendingCapture | null>(null)
  const [tool, setTool] = useState<EditorTool>('select')
  const [color, setColor] = useState('#ff0000')
  const [strokeWidth, setStrokeWidth] = useState(2)
  const [fabricCanvas, setFabricCanvas] = useState<FabricCanvas | null>(null)
  const [zoom, setZoom] = useState(1)
  // 팔레트
  const [palette, setPalette] = useState<string[]>([])
  const [showPalettePanel, setShowPalettePanel] = useState(false)
  const [palettePanelPos, setPalettePanelPos] = useState({ top: 0, right: 0 })
  const paletteBtnRef = useRef<HTMLButtonElement>(null)
  const [showExportPanel, setShowExportPanel] = useState(false)
  const [exportPanelPos, setExportPanelPos] = useState({ top: 0, right: 0 })
  const exportBtnRef = useRef<HTMLButtonElement>(null)
  // 크롭 선택 상태
  const [cropSel, setCropSel] = useState<{ x: number; y: number; w: number; h: number; btnLeft: number; btnTop: number } | null>(null)
  const cropRectRef = useRef<import('fabric').Rect | null>(null)
  // Undo / Redo 스택
  const undoStackRef = useRef<Array<{ dataUrl: string; width: number; height: number }>>([])
  const redoStackRef = useRef<Array<{ dataUrl: string; width: number; height: number }>>([])
  const preActionRef = useRef<{ dataUrl: string; width: number; height: number } | null>(null)
  const toolRef = useRef<EditorTool>('select')
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fabricRef = useRef<FabricCanvas | null>(null)
  const zoomRef = useRef(1)
  const originalSizeRef = useRef({ width: 0, height: 0 })
  const canvasWrapperRef = useRef<HTMLDivElement>(null)
  // 도형 드래그 프리뷰
  const previewObjRef = useRef<FabricObject | null>(null)
  const shapeStartRef = useRef<{ x: number; y: number } | null>(null)
  const stickerNumRef = useRef(1)
  // 리사이즈 패널
  const [showResizePanel, setShowResizePanel] = useState(false)
  const [resizeW, setResizeW] = useState(0)
  const [resizeH, setResizeH] = useState(0)
  const [resizeLocked, setResizeLocked] = useState(true)
  const resizeRatioRef = useRef(1)
  // 밝기/대비 패널
  const [showAdjustPanel, setShowAdjustPanel] = useState(false)
  const [adjustBrightness, setAdjustBrightness] = useState(100)
  const [adjustContrast, setAdjustContrast] = useState(100)
  // 워터마크 패널
  const [showWatermarkPanel, setShowWatermarkPanel] = useState(false)
  const [watermarkText, setWatermarkText] = useState('© 2025')
  const [watermarkPos, setWatermarkPos] = useState<'bottomright' | 'bottomleft' | 'topleft' | 'topright' | 'center'>('bottomright')
  const [watermarkOpacity, setWatermarkOpacity] = useState(70)

  // 썸네일 자동 다운로드 모드 (?dl=thumb)
  useEffect(() => {
    if (!new URLSearchParams(location.search).has('dl')) return
    const run = () => new Promise<void>((resolve) => {
      const req = indexedDB.open('uriScreenShot', 1)
      req.onupgradeneeded = () => req.result.createObjectStore('pending')
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction('pending', 'readwrite')
        const store = tx.objectStore('pending')
        const get = store.get('thumbDownload')
        get.onsuccess = () => {
          if (get.result) {
            store.delete('thumbDownload')
            const { dataUrl, filename } = get.result as { dataUrl: string; filename: string; subdir: string }
            const a = document.createElement('a')
            a.href = dataUrl
            a.download = filename
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            setTimeout(() => window.close(), 800)
          }
          tx.oncomplete = () => { db.close(); resolve() }
        }
        tx.onerror = () => { db.close(); resolve() }
      }
      req.onerror = () => resolve()
    })
    run()
  }, [])

  // 캡처 데이터 로드 (IndexedDB에서 읽기)
  useEffect(() => {
    if (new URLSearchParams(location.search).has('dl')) return  // 자동 다운로드 모드면 스킵
    const load = () => new Promise<void>((resolve) => {
      const req = indexedDB.open('uriScreenShot', 1)
      req.onupgradeneeded = () => req.result.createObjectStore('pending')
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction('pending', 'readwrite')
        const store = tx.objectStore('pending')
        const get = store.get('pendingCapture')
        get.onsuccess = () => {
          if (get.result) {
            store.delete('pendingCapture')
            setCapture(get.result as PendingCapture)
          }
          tx.oncomplete = () => { db.close(); resolve() }
        }
        tx.onerror = () => { db.close(); resolve() }
      }
      req.onerror = () => resolve()
    })
    load()
  }, [])

  // Fabric.js 초기화
  useEffect(() => {
    if (!capture || !canvasRef.current) return

    let cancelled = false
    import('fabric').then(({ Canvas, FabricImage }) => {
      if (cancelled || !canvasRef.current) return
      // 이미지 비율을 유지하면서 화면에 맞게 scale 계산
      const scaleX = (window.innerWidth - 40) / capture.width
      const scaleY = (window.innerHeight - 120) / capture.height
      const scale = Math.min(scaleX, scaleY, 1)
      // 캔버스를 실제 표시 이미지 크기와 동일하게 생성 (여백 없음)
      const initWidth = Math.round(capture.width * scale)
      const initHeight = Math.round(capture.height * scale)
      originalSizeRef.current = { width: initWidth, height: initHeight }

      const fc = new Canvas(canvasRef.current, {
        width: initWidth,
        height: initHeight,
        selection: true,
      })

      FabricImage.fromURL(capture.dataUrl).then(img => {
        if (cancelled) return
        img.set({ scaleX: scale, scaleY: scale, selectable: false, evented: false })
        fc.backgroundImage = img
        fc.renderAll()
      })

      // 영구 undo 추적 리스너 (도구 전환 시 제거되지 않음)
      fc.on('path:created', () => {
        if (preActionRef.current) { pushUndo(preActionRef.current); preActionRef.current = null }
      })
      fc.on('before:transform', () => {
        preActionRef.current = {
          dataUrl: fc.toDataURL({ format: 'png', multiplier: 1 / zoomRef.current }),
          width: originalSizeRef.current.width,
          height: originalSizeRef.current.height,
        }
      })
      fc.on('object:modified', () => {
        if (preActionRef.current) { pushUndo(preActionRef.current); preActionRef.current = null }
      })

      fabricRef.current = fc
      setFabricCanvas(fc)
    })

    return () => {
      cancelled = true
      fabricRef.current?.dispose()
    }
  // pushUndo는 [] deps로 불변 → deps 제외 (fabric init이 pushUndo 선언보다 앞에 위치해 TDZ 발생 방지)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capture])

  // ─── Undo / Undo / Redo ─────────────────────────────────────────────────────
  const snapshotNow = useCallback((): { dataUrl: string; width: number; height: number } => {
    const fc = fabricRef.current!
    return {
      dataUrl: fc.toDataURL({ format: 'png', multiplier: 1 / zoomRef.current }),
      width: originalSizeRef.current.width,
      height: originalSizeRef.current.height,
    }
  }, [])

  const pushUndo = useCallback((entry: { dataUrl: string; width: number; height: number }) => {
    undoStackRef.current = [...undoStackRef.current.slice(-29), entry]
    redoStackRef.current = []
    setCanUndo(true)
    setCanRedo(false)
  }, [])

  const restoreEntry = useCallback(async (entry: { dataUrl: string; width: number; height: number }) => {
    const fc = fabricRef.current
    if (!fc) return
    const { FabricImage } = await import('fabric')
    if (cropRectRef.current) { fc.remove(cropRectRef.current); cropRectRef.current = null }
    setCropSel(null)
    fc.clear()
    fc.setZoom(1); zoomRef.current = 1; setZoom(1)
    fc.setWidth(entry.width); fc.setHeight(entry.height)
    originalSizeRef.current = { width: entry.width, height: entry.height }
    const fImg = await FabricImage.fromURL(entry.dataUrl)
    fImg.set({ selectable: false, evented: false })
    fc.backgroundImage = fImg
    fc.renderAll()
    setTool('select')
  }, [])

  const undo = useCallback(async () => {
    if (undoStackRef.current.length === 0) return
    const fc = fabricRef.current; if (!fc) return
    const current = snapshotNow()
    redoStackRef.current = [current, ...redoStackRef.current.slice(0, 29)]
    const prev = undoStackRef.current[undoStackRef.current.length - 1]
    undoStackRef.current = undoStackRef.current.slice(0, -1)
    setCanUndo(undoStackRef.current.length > 0)
    setCanRedo(true)
    await restoreEntry(prev)
  }, [snapshotNow, restoreEntry])

  const redo = useCallback(async () => {
    if (redoStackRef.current.length === 0) return
    const fc = fabricRef.current; if (!fc) return
    const current = snapshotNow()
    undoStackRef.current = [...undoStackRef.current.slice(-29), current]
    const next = redoStackRef.current[0]
    redoStackRef.current = redoStackRef.current.slice(1)
    setCanUndo(true)
    setCanRedo(redoStackRef.current.length > 0)
    await restoreEntry(next)
  }, [snapshotNow, restoreEntry])

  // 줌 적용
  const applyZoom = useCallback((newZoom: number) => {
    const fc = fabricRef.current
    if (!fc) return
    const clamped = Math.max(0.1, Math.min(5, Math.round(newZoom * 10) / 10))
    zoomRef.current = clamped
    setZoom(clamped)
    const { width, height } = originalSizeRef.current
    fc.setZoom(clamped)
    fc.setWidth(Math.round(width * clamped))
    fc.setHeight(Math.round(height * clamped))
    fc.renderAll()
  }, [])

  // 휠 줌 (Fabric mouse:wheel 이벤트 사용 - Fabric이 캔버스 이벤트를 가로채므로)
  useEffect(() => {
    const fc = fabricRef.current
    if (!fc) return
    const onWheel = (opt: { e: Event }) => {
      const e = opt.e as WheelEvent
      e.preventDefault()
      const delta = e.deltaY < 0 ? 0.1 : -0.1
      applyZoom(zoomRef.current + delta)
    }
    fc.on('mouse:wheel', onWheel)
    return () => { fc.off('mouse:wheel', onWheel) }
  // fabricCanvas가 생성된 후 연결 (fabricCanvas state로 트리거)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fabricCanvas, applyZoom])

  // Ctrl+Z / Ctrl+Y 단축키
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!fabricRef.current) return
      const ctrl = e.ctrlKey || e.metaKey
      if (ctrl && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo() }
      if (ctrl && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); redo() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [undo, redo])

  // 모자이크 적용 헬퍼
  const applyMosaic = useCallback(async (left: number, top: number, width: number, height: number) => {
    const fc = fabricRef.current
    if (!fc || width <= 0 || height <= 0) return
    const { FabricImage } = await import('fabric')
    const tmpCanvas = document.createElement('canvas')
    tmpCanvas.width = width
    tmpCanvas.height = height
    const tmpCtx = tmpCanvas.getContext('2d')!
    const dataUrl = fc.toDataURL({ format: 'png', multiplier: 1 })
    const img = new Image()
    await new Promise<void>(resolve => {
      img.onload = () => resolve()
      img.src = dataUrl
    })
    tmpCtx.filter = 'blur(8px)'
    tmpCtx.drawImage(img, left, top, width, height, 0, 0, width, height)
    const mosaicDataUrl = tmpCanvas.toDataURL('image/png')
    FabricImage.fromURL(mosaicDataUrl).then(fabricImg => {
      fabricImg.set({ left, top, selectable: false, evented: false })
      fc.add(fabricImg)
      fc.renderAll()
      if (preActionRef.current) { pushUndo(preActionRef.current); preActionRef.current = null }
    })
  }, [pushUndo])

  // ─── 페인트통 (플러드 필) ──────────────────────────────────────────────────────
  const applyFill = useCallback(async (origX: number, origY: number) => {
    const fc = fabricRef.current
    if (!fc) return

    pushUndo(snapshotNow())

    // 현재 캔버스를 원본 해상도 PNG로 추출
    const zoom = zoomRef.current
    const dataUrl = fc.toDataURL({ format: 'png', multiplier: 1 / zoom })
    const { width, height } = originalSizeRef.current

    const tmp = document.createElement('canvas')
    tmp.width = width; tmp.height = height
    const ctx = tmp.getContext('2d', { willReadFrequently: true })!
    const img = new Image()
    await new Promise<void>(res => { img.onload = () => res(); img.src = dataUrl })
    ctx.drawImage(img, 0, 0)

    const imageData = ctx.getImageData(0, 0, width, height)
    const d = imageData.data

    // 클릭 색상
    const si = (origY * width + origX) * 4
    const tr = d[si], tg = d[si + 1], tb = d[si + 2], ta = d[si + 3]

    // 채울 색상 파싱
    const fr = parseInt(color.slice(1, 3), 16)
    const fg = parseInt(color.slice(3, 5), 16)
    const fb = parseInt(color.slice(5, 7), 16)
    if (tr === fr && tg === fg && tb === fb) return  // 이미 같은 색

    const TOLERANCE = 28
    const match = (i: number) =>
      Math.abs(d[i] - tr) <= TOLERANCE &&
      Math.abs(d[i + 1] - tg) <= TOLERANCE &&
      Math.abs(d[i + 2] - tb) <= TOLERANCE &&
      Math.abs(d[i + 3] - ta) <= TOLERANCE

    // BFS 플러드 필
    const visited = new Uint8Array(width * height)
    const queue: number[] = []
    const start = origY * width + origX
    queue.push(start); visited[start] = 1

    let head = 0
    while (head < queue.length) {
      const pos = queue[head++]
      const x = pos % width
      const y = (pos - x) / width
      const i = pos * 4
      d[i] = fr; d[i + 1] = fg; d[i + 2] = fb; d[i + 3] = 255

      const ns = [
        x > 0 ? pos - 1 : -1,
        x < width - 1 ? pos + 1 : -1,
        y > 0 ? pos - width : -1,
        y < height - 1 ? pos + width : -1,
      ]
      for (const n of ns) {
        if (n < 0 || visited[n]) continue
        if (match(n * 4)) { visited[n] = 1; queue.push(n) }
      }
    }

    ctx.putImageData(imageData, 0, 0)
    const filledUrl = tmp.toDataURL('image/png')

    const { FabricImage } = await import('fabric')
    const fImg = await FabricImage.fromURL(filledUrl)
    fImg.set({ selectable: false, evented: false })
    fc.clear()
    originalSizeRef.current = { width, height }
    fc.setZoom(zoom)
    fc.setWidth(Math.round(width * zoom))
    fc.setHeight(Math.round(height * zoom))
    fc.backgroundImage = fImg
    fc.renderAll()
  }, [color, pushUndo, snapshotNow])

  // ─── 90° 회전 ──────────────────────────────────────────────────────────────
  const rotate90 = useCallback(async () => {
    const fc = fabricRef.current
    if (!fc) return
    pushUndo(snapshotNow())
    const { width, height } = originalSizeRef.current
    const dataUrl = fc.toDataURL({ format: 'png', multiplier: 1 / zoomRef.current })
    const tmp = document.createElement('canvas')
    tmp.width = height; tmp.height = width
    const ctx = tmp.getContext('2d')!
    const img = new Image()
    await new Promise<void>(res => { img.onload = () => res(); img.src = dataUrl })
    ctx.translate(height / 2, width / 2)
    ctx.rotate(Math.PI / 2)
    ctx.drawImage(img, -width / 2, -height / 2)
    const rotatedUrl = tmp.toDataURL('image/png')
    const { FabricImage } = await import('fabric')
    fc.clear()
    fc.setZoom(1); zoomRef.current = 1; setZoom(1)
    fc.setWidth(height); fc.setHeight(width)
    originalSizeRef.current = { width: height, height: width }
    const fImg = await FabricImage.fromURL(rotatedUrl)
    fImg.set({ selectable: false, evented: false })
    fc.backgroundImage = fImg
    fc.renderAll()
    setTool('select')
  }, [pushUndo, snapshotNow])

  // ─── 이미지 리사이즈 ────────────────────────────────────────────────────────
  const applyResize = useCallback(async (newW: number, newH: number) => {
    const fc = fabricRef.current
    if (!fc || newW <= 0 || newH <= 0) return
    pushUndo(snapshotNow())
    const dataUrl = fc.toDataURL({ format: 'png', multiplier: 1 / zoomRef.current })
    const tmp = document.createElement('canvas')
    tmp.width = newW; tmp.height = newH
    const ctx = tmp.getContext('2d')!
    const img = new Image()
    await new Promise<void>(res => { img.onload = () => res(); img.src = dataUrl })
    ctx.drawImage(img, 0, 0, newW, newH)
    const resizedUrl = tmp.toDataURL('image/png')
    const { FabricImage } = await import('fabric')
    fc.clear()
    fc.setZoom(1); zoomRef.current = 1; setZoom(1)
    fc.setWidth(newW); fc.setHeight(newH)
    originalSizeRef.current = { width: newW, height: newH }
    const fImg = await FabricImage.fromURL(resizedUrl)
    fImg.set({ selectable: false, evented: false })
    fc.backgroundImage = fImg
    fc.renderAll()
    setShowResizePanel(false)
    setTool('select')
  }, [pushUndo, snapshotNow])

  // ─── 밝기 / 대비 조절 ──────────────────────────────────────────────────────
  const applyAdjust = useCallback(async (brightness: number, contrast: number) => {
    const fc = fabricRef.current
    if (!fc) return
    pushUndo(snapshotNow())
    const { width, height } = originalSizeRef.current
    const dataUrl = fc.toDataURL({ format: 'png', multiplier: 1 / zoomRef.current })
    const tmp = document.createElement('canvas')
    tmp.width = width; tmp.height = height
    const ctx = tmp.getContext('2d')!
    const img = new Image()
    await new Promise<void>(res => { img.onload = () => res(); img.src = dataUrl })
    ctx.filter = `brightness(${brightness}%) contrast(${contrast}%)`
    ctx.drawImage(img, 0, 0)
    const adjustedUrl = tmp.toDataURL('image/png')
    const { FabricImage } = await import('fabric')
    fc.clear()
    fc.setZoom(1); zoomRef.current = 1; setZoom(1)
    fc.setWidth(width); fc.setHeight(height)
    originalSizeRef.current = { width, height }
    const fImg = await FabricImage.fromURL(adjustedUrl)
    fImg.set({ selectable: false, evented: false })
    fc.backgroundImage = fImg
    fc.renderAll()
    setShowAdjustPanel(false)
    setTool('select')
  }, [pushUndo, snapshotNow])

  // ─── 워터마크 추가 ──────────────────────────────────────────────────────────
  const applyWatermark = useCallback(async (text: string, pos: string, opacity: number) => {
    const fc = fabricRef.current
    if (!fc || !text.trim()) return
    pushUndo(snapshotNow())
    const { width, height } = originalSizeRef.current
    const dataUrl = fc.toDataURL({ format: 'png', multiplier: 1 / zoomRef.current })
    const tmp = document.createElement('canvas')
    tmp.width = width; tmp.height = height
    const ctx = tmp.getContext('2d')!
    const img = new Image()
    await new Promise<void>(res => { img.onload = () => res(); img.src = dataUrl })
    ctx.drawImage(img, 0, 0)
    const fontSize = Math.max(14, Math.round(width * 0.025))
    ctx.font = `bold ${fontSize}px -apple-system, sans-serif`
    const tw = ctx.measureText(text).width
    const pad = Math.round(fontSize * 0.8)
    let tx = pad, ty = height - pad
    if (pos === 'bottomright') { tx = width - tw - pad; ty = height - pad }
    else if (pos === 'bottomleft') { tx = pad; ty = height - pad }
    else if (pos === 'topleft') { tx = pad; ty = fontSize + pad }
    else if (pos === 'topright') { tx = width - tw - pad; ty = fontSize + pad }
    else if (pos === 'center') { tx = (width - tw) / 2; ty = (height + fontSize) / 2 }
    ctx.globalAlpha = opacity / 100
    ctx.shadowColor = 'rgba(0,0,0,0.7)'
    ctx.shadowBlur = 4
    ctx.fillStyle = '#ffffff'
    ctx.fillText(text, tx, ty)
    ctx.globalAlpha = 1
    const watermarkedUrl = tmp.toDataURL('image/png')
    const { FabricImage } = await import('fabric')
    fc.clear()
    fc.setZoom(1); zoomRef.current = 1; setZoom(1)
    fc.setWidth(width); fc.setHeight(height)
    originalSizeRef.current = { width, height }
    const fImg = await FabricImage.fromURL(watermarkedUrl)
    fImg.set({ selectable: false, evented: false })
    fc.backgroundImage = fImg
    fc.renderAll()
    setShowWatermarkPanel(false)
    setTool('select')
  }, [pushUndo, snapshotNow])

  // 도구 변경
  useEffect(() => {
    const fc = fabricRef.current
    if (!fc) return
    toolRef.current = tool
    fc.isDrawingMode = false
    fc.selection = tool === 'select'
    fc.defaultCursor =
      tool === 'eyedropper' ? 'crosshair' :
      tool === 'hand' ? 'grab' :
      tool === 'zoom' ? 'zoom-in' :
      'default'
    fc.hoverCursor =
      tool === 'eyedropper' ? 'crosshair' :
      tool === 'hand' ? 'grab' :
      tool === 'zoom' ? 'zoom-in' :
      'move'

    fc.off('mouse:down')
    fc.off('mouse:move')
    fc.off('mouse:up')

    // 드래그 프리뷰 정리
    if (previewObjRef.current) { fc.remove(previewObjRef.current); previewObjRef.current = null; fc.renderAll() }
    shapeStartRef.current = null

    if (tool === 'fill') {
      fc.defaultCursor = 'crosshair'
      fc.hoverCursor = 'crosshair'
      fc.on('mouse:down', (opt) => {
        const e = opt.e as MouseEvent
        const canvasEl = canvasRef.current!
        const rect = canvasEl.getBoundingClientRect()
        const scaleX = canvasEl.width / rect.width
        const scaleY = canvasEl.height / rect.height
        const px = Math.max(0, Math.min(Math.round((e.clientX - rect.left) * scaleX), canvasEl.width - 1))
        const py = Math.max(0, Math.min(Math.round((e.clientY - rect.top) * scaleY), canvasEl.height - 1))
        const { width, height } = originalSizeRef.current
        const origX = Math.max(0, Math.min(Math.round(px / zoomRef.current), width - 1))
        const origY = Math.max(0, Math.min(Math.round(py / zoomRef.current), height - 1))
        applyFill(origX, origY)
      })
    } else if (tool === 'hand') {
      let dragging = false
      let lastX = 0
      let lastY = 0

      fc.selection = false
      fc.defaultCursor = 'grab'
      fc.hoverCursor = 'grab'

      fc.on('mouse:down', (opt) => {
        const e = opt.e as MouseEvent
        dragging = true
        lastX = e.clientX
        lastY = e.clientY
        fc.defaultCursor = 'grabbing'
        fc.hoverCursor = 'grabbing'
      })

      fc.on('mouse:move', (opt) => {
        if (!dragging) return
        const e = opt.e as MouseEvent
        const wrapper = canvasWrapperRef.current
        if (!wrapper) return
        wrapper.scrollLeft -= e.clientX - lastX
        wrapper.scrollTop -= e.clientY - lastY
        lastX = e.clientX
        lastY = e.clientY
      })

      fc.on('mouse:up', () => {
        dragging = false
        fc.defaultCursor = 'grab'
        fc.hoverCursor = 'grab'
      })
    } else if (tool === 'zoom') {
      fc.selection = false
      fc.defaultCursor = 'zoom-in'
      fc.hoverCursor = 'zoom-in'
      fc.on('mouse:down', (opt) => {
        const e = opt.e as MouseEvent
        const delta = e.shiftKey || e.altKey ? -0.2 : 0.2
        applyZoom(zoomRef.current + delta)
      })
    } else if (tool === 'pen') {
      import('fabric').then(({ PencilBrush }) => {
        fc.freeDrawingBrush = new PencilBrush(fc)
        fc.freeDrawingBrush.color = color
        fc.freeDrawingBrush.width = strokeWidth
        fc.isDrawingMode = true
      })
      // 획 시작 시 pre-action 스냅샷 (path:created에서 pushUndo)
      fc.on('mouse:down', () => {
        preActionRef.current = {
          dataUrl: fc.toDataURL({ format: 'png', multiplier: 1 / zoomRef.current }),
          width: originalSizeRef.current.width,
          height: originalSizeRef.current.height,
        }
      })
    } else if (tool === 'eyedropper') {
      fc.on('mouse:down', (opt) => {
        const e = opt.e as MouseEvent
        const canvasEl = canvasRef.current!
        // lowerCanvasEl(렌더링 레이어) 위치 기준으로 정확히 계산
        const rect = canvasEl.getBoundingClientRect()
        // CSS 픽셀 → 내부 픽셀 변환 (CSS size와 attribute size 불일치 대응)
        const scaleX = canvasEl.width / rect.width
        const scaleY = canvasEl.height / rect.height
        const px = Math.max(0, Math.min(Math.round((e.clientX - rect.left) * scaleX), canvasEl.width - 1))
        const py = Math.max(0, Math.min(Math.round((e.clientY - rect.top) * scaleY), canvasEl.height - 1))
        const d = canvasEl.getContext('2d')!.getImageData(px, py, 1, 1).data
        const hex = '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('')
        setColor(hex)
        setTool('select')
      })
    } else if (tool === 'mosaic') {
      let isDrawing = false
      let startX = 0
      let startY = 0
      fc.on('mouse:down', (opt) => {
        isDrawing = true
        preActionRef.current = {
          dataUrl: fc.toDataURL({ format: 'png', multiplier: 1 / zoomRef.current }),
          width: originalSizeRef.current.width,
          height: originalSizeRef.current.height,
        }
        const pointer = fc.getPointer(opt.e)
        startX = pointer.x
        startY = pointer.y
      })
      fc.on('mouse:up', (opt) => {
        if (!isDrawing) return
        isDrawing = false
        const pointer = fc.getPointer(opt.e)
        const left = Math.min(startX, pointer.x)
        const top = Math.min(startY, pointer.y)
        const width = Math.abs(pointer.x - startX)
        const height = Math.abs(pointer.y - startY)
        applyMosaic(left, top, width, height)
      })
    } else if (tool === 'crop') {
      // 도구 전환 시 이전 크롭 선택 초기화
      if (cropRectRef.current) { fc.remove(cropRectRef.current); cropRectRef.current = null; fc.renderAll() }
      setCropSel(null)

      let drawing = false, sx = 0, sy = 0

      fc.on('mouse:down', (opt) => {
        // 이미 선택 있으면 새로 시작
        if (cropRectRef.current) { fc.remove(cropRectRef.current); cropRectRef.current = null; fc.renderAll() }
        setCropSel(null)
        drawing = true
        const p = fc.getPointer(opt.e)
        sx = p.x; sy = p.y
      })

      fc.on('mouse:move', async (opt) => {
        if (!drawing) return
        const { Rect } = await import('fabric')
        const p = fc.getPointer(opt.e)
        const x = Math.min(sx, p.x), y = Math.min(sy, p.y)
        const w = Math.abs(p.x - sx), h = Math.abs(p.y - sy)
        if (w < 2 || h < 2) return
        if (cropRectRef.current) fc.remove(cropRectRef.current)
        const z = zoomRef.current
        cropRectRef.current = new Rect({
          left: x, top: y, width: w, height: h,
          fill: 'rgba(74,144,226,0.12)',
          stroke: '#4A90E2', strokeWidth: 1.5 / z,
          strokeDashArray: [6 / z, 3 / z],
          selectable: false, evented: false,
        })
        fc.add(cropRectRef.current)
        fc.renderAll()
      })

      fc.on('mouse:up', (opt) => {
        if (!drawing) return
        drawing = false
        const p = fc.getPointer(opt.e)
        const x = Math.min(sx, p.x), y = Math.min(sy, p.y)
        const w = Math.abs(p.x - sx), h = Math.abs(p.y - sy)
        if (w <= 5 || h <= 5) {
          if (cropRectRef.current) { fc.remove(cropRectRef.current); cropRectRef.current = null; fc.renderAll() }
          return
        }
        // 확인 버튼 위치: 선택 사각형 바로 아래
        const z = zoomRef.current
        const canvasEl = canvasRef.current!
        const wrapperEl = canvasWrapperRef.current!
        const cr = canvasEl.getBoundingClientRect()
        const wr = wrapperEl.getBoundingClientRect()
        const btnLeft = cr.left - wr.left + wrapperEl.scrollLeft + x * z
        const btnTop  = cr.top  - wr.top  + wrapperEl.scrollTop  + (y + h) * z + 6
        setCropSel({ x, y, w, h, btnLeft, btnTop })
      })
    }
    else if (tool === 'arrow') {
      fc.defaultCursor = 'crosshair'
      fc.hoverCursor = 'crosshair'
      fc.on('mouse:down', (opt) => {
        const p = fc.getPointer(opt.e)
        shapeStartRef.current = { x: p.x, y: p.y }
        preActionRef.current = {
          dataUrl: fc.toDataURL({ format: 'png', multiplier: 1 / zoomRef.current }),
          width: originalSizeRef.current.width, height: originalSizeRef.current.height,
        }
      })
      fc.on('mouse:move', async (opt) => {
        if (!shapeStartRef.current) return
        const { Path } = await import('fabric')
        const p = fc.getPointer(opt.e)
        const { x: sx, y: sy } = shapeStartRef.current
        if (previewObjRef.current) { fc.remove(previewObjRef.current); previewObjRef.current = null }
        const dx = p.x - sx, dy = p.y - sy
        if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return
        const angle = Math.atan2(dy, dx)
        const hl = Math.max(12, strokeWidth * 4)
        const ha = Math.PI / 6
        const pathStr = `M ${sx} ${sy} L ${p.x} ${p.y} M ${p.x} ${p.y} L ${p.x - hl * Math.cos(angle - ha)} ${p.y - hl * Math.sin(angle - ha)} M ${p.x} ${p.y} L ${p.x - hl * Math.cos(angle + ha)} ${p.y - hl * Math.sin(angle + ha)}`
        const arrow = new Path(pathStr, { stroke: color, strokeWidth, fill: '', selectable: false, evented: false })
        previewObjRef.current = arrow
        fc.add(arrow); fc.renderAll()
      })
      fc.on('mouse:up', async (opt) => {
        if (!shapeStartRef.current) return
        const { Path } = await import('fabric')
        const p = fc.getPointer(opt.e)
        const { x: sx, y: sy } = shapeStartRef.current
        shapeStartRef.current = null
        if (previewObjRef.current) { fc.remove(previewObjRef.current); previewObjRef.current = null }
        const dx = p.x - sx, dy = p.y - sy
        if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return
        const angle = Math.atan2(dy, dx)
        const hl = Math.max(12, strokeWidth * 4)
        const ha = Math.PI / 6
        const pathStr = `M ${sx} ${sy} L ${p.x} ${p.y} M ${p.x} ${p.y} L ${p.x - hl * Math.cos(angle - ha)} ${p.y - hl * Math.sin(angle - ha)} M ${p.x} ${p.y} L ${p.x - hl * Math.cos(angle + ha)} ${p.y - hl * Math.sin(angle + ha)}`
        const arrow = new Path(pathStr, { stroke: color, strokeWidth, fill: '', selectable: true, evented: true })
        fc.add(arrow); fc.setActiveObject(arrow); fc.renderAll()
        if (preActionRef.current) { pushUndo(preActionRef.current); preActionRef.current = null }
      })
    } else if (tool === 'ellipse') {
      fc.defaultCursor = 'crosshair'
      fc.hoverCursor = 'crosshair'
      fc.on('mouse:down', (opt) => {
        const p = fc.getPointer(opt.e)
        shapeStartRef.current = { x: p.x, y: p.y }
        preActionRef.current = {
          dataUrl: fc.toDataURL({ format: 'png', multiplier: 1 / zoomRef.current }),
          width: originalSizeRef.current.width, height: originalSizeRef.current.height,
        }
      })
      fc.on('mouse:move', async (opt) => {
        if (!shapeStartRef.current) return
        const { Ellipse } = await import('fabric')
        const p = fc.getPointer(opt.e)
        const { x: sx, y: sy } = shapeStartRef.current
        if (previewObjRef.current) { fc.remove(previewObjRef.current); previewObjRef.current = null }
        const rx = Math.abs(p.x - sx) / 2, ry = Math.abs(p.y - sy) / 2
        if (rx < 2 || ry < 2) return
        const ell = new Ellipse({ left: Math.min(sx, p.x), top: Math.min(sy, p.y), rx, ry, fill: 'transparent', stroke: color, strokeWidth, selectable: false, evented: false })
        previewObjRef.current = ell
        fc.add(ell); fc.renderAll()
      })
      fc.on('mouse:up', async (opt) => {
        if (!shapeStartRef.current) return
        const { Ellipse } = await import('fabric')
        const p = fc.getPointer(opt.e)
        const { x: sx, y: sy } = shapeStartRef.current
        shapeStartRef.current = null
        if (previewObjRef.current) { fc.remove(previewObjRef.current); previewObjRef.current = null }
        const rx = Math.abs(p.x - sx) / 2, ry = Math.abs(p.y - sy) / 2
        if (rx < 5 || ry < 5) return
        const ell = new Ellipse({ left: Math.min(sx, p.x), top: Math.min(sy, p.y), rx, ry, fill: 'transparent', stroke: color, strokeWidth, selectable: true, evented: true })
        fc.add(ell); fc.setActiveObject(ell); fc.renderAll()
        if (preActionRef.current) { pushUndo(preActionRef.current); preActionRef.current = null }
      })
    } else if (tool === 'highlight') {
      fc.defaultCursor = 'crosshair'
      fc.hoverCursor = 'crosshair'
      fc.on('mouse:down', (opt) => {
        const p = fc.getPointer(opt.e)
        shapeStartRef.current = { x: p.x, y: p.y }
        preActionRef.current = {
          dataUrl: fc.toDataURL({ format: 'png', multiplier: 1 / zoomRef.current }),
          width: originalSizeRef.current.width, height: originalSizeRef.current.height,
        }
      })
      fc.on('mouse:move', async (opt) => {
        if (!shapeStartRef.current) return
        const { Rect } = await import('fabric')
        const p = fc.getPointer(opt.e)
        const { x: sx, y: sy } = shapeStartRef.current
        if (previewObjRef.current) { fc.remove(previewObjRef.current); previewObjRef.current = null }
        const w = Math.abs(p.x - sx), h = Math.abs(p.y - sy)
        if (w < 2 || h < 2) return
        const r = parseInt(color.slice(1, 3), 16), g = parseInt(color.slice(3, 5), 16), b = parseInt(color.slice(5, 7), 16)
        const rect = new Rect({ left: Math.min(sx, p.x), top: Math.min(sy, p.y), width: w, height: h, fill: `rgba(${r},${g},${b},0.35)`, stroke: 'none', strokeWidth: 0, selectable: false, evented: false })
        previewObjRef.current = rect
        fc.add(rect); fc.renderAll()
      })
      fc.on('mouse:up', async (opt) => {
        if (!shapeStartRef.current) return
        const { Rect } = await import('fabric')
        const p = fc.getPointer(opt.e)
        const { x: sx, y: sy } = shapeStartRef.current
        shapeStartRef.current = null
        if (previewObjRef.current) { fc.remove(previewObjRef.current); previewObjRef.current = null }
        const w = Math.abs(p.x - sx), h = Math.abs(p.y - sy)
        if (w < 5 || h < 5) return
        const r = parseInt(color.slice(1, 3), 16), g = parseInt(color.slice(3, 5), 16), b = parseInt(color.slice(5, 7), 16)
        const rect = new Rect({ left: Math.min(sx, p.x), top: Math.min(sy, p.y), width: w, height: h, fill: `rgba(${r},${g},${b},0.35)`, stroke: 'none', strokeWidth: 0, selectable: true, evented: true })
        fc.add(rect); fc.setActiveObject(rect); fc.renderAll()
        if (preActionRef.current) { pushUndo(preActionRef.current); preActionRef.current = null }
      })
    } else if (tool === 'number') {
      fc.defaultCursor = 'crosshair'
      fc.hoverCursor = 'crosshair'
      fc.on('mouse:down', async (opt) => {
        const { FabricImage } = await import('fabric')
        const p = fc.getPointer(opt.e)
        pushUndo(snapshotNow())
        const num = stickerNumRef.current++
        const radius = 16
        const tmp = document.createElement('canvas')
        tmp.width = radius * 2; tmp.height = radius * 2
        const ctx = tmp.getContext('2d')!
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(radius, radius, radius - 1, 0, Math.PI * 2)
        ctx.fill()
        ctx.font = `bold ${radius * 1.1}px sans-serif`
        ctx.fillStyle = '#fff'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(String(num), radius, radius)
        const dataUrl = tmp.toDataURL('image/png')
        const fImg = await FabricImage.fromURL(dataUrl)
        fImg.set({ left: p.x - radius, top: p.y - radius, selectable: true, evented: true })
        fc.add(fImg); fc.setActiveObject(fImg); fc.renderAll()
      })
    }
  }, [tool, color, strokeWidth, applyMosaic, applyFill, pushUndo, snapshotNow, applyZoom])

  // ─── 선택 영역 지우기 ────────────────────────────────────────────────────────
  const eraseRegion = useCallback(async () => {
    const fc = fabricRef.current
    if (!fc || !cropSel) return
    const { FabricImage } = await import('fabric')

    // 크롭 선택 사각형 제거 후 현재 상태를 undo 스택에 저장
    if (cropRectRef.current) { fc.remove(cropRectRef.current); cropRectRef.current = null }
    pushUndo(snapshotNow())

    const { x, y, w, h } = cropSel
    setCropSel(null)

    // 현재 캔버스를 원본 해상도로 추출 → 해당 영역을 흰색으로 덮음
    const fullUrl = fc.toDataURL({ format: 'png', multiplier: 1 / zoomRef.current })
    const { width, height } = originalSizeRef.current

    const tmp = document.createElement('canvas')
    tmp.width = width; tmp.height = height
    const ctx = tmp.getContext('2d')!
    const img = new Image()
    await new Promise<void>(res => { img.onload = () => res(); img.src = fullUrl })
    ctx.drawImage(img, 0, 0)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h))
    const erasedUrl = tmp.toDataURL('image/png')

    // 캔버스 업데이트 (크기 유지)
    fc.clear()
    fc.setZoom(1); zoomRef.current = 1; setZoom(1)
    fc.setWidth(width); fc.setHeight(height)
    originalSizeRef.current = { width, height }

    const fImg = await FabricImage.fromURL(erasedUrl)
    fImg.set({ selectable: false, evented: false })
    fc.backgroundImage = fImg
    fc.renderAll()
    setTool('select')
  }, [cropSel, pushUndo, snapshotNow])

  // ─── 크롭 확인 ───────────────────────────────────────────────────────────────
  const confirmCrop = useCallback(async () => {
    const fc = fabricRef.current
    if (!fc || !cropSel) return
    const { FabricImage } = await import('fabric')

    // 크롭 선택 사각형 제거 후 현재 상태를 undo 스택에 저장
    if (cropRectRef.current) { fc.remove(cropRectRef.current); cropRectRef.current = null }
    pushUndo(snapshotNow())

    const { x, y, w, h } = cropSel
    setCropSel(null)

    // 임시 canvas로 크롭
    const fullUrl = fc.toDataURL({ format: 'png', multiplier: 1 / zoomRef.current })
    const tmp = document.createElement('canvas')
    tmp.width = Math.round(w); tmp.height = Math.round(h)
    const img = new Image()
    await new Promise<void>(res => { img.onload = () => res(); img.src = fullUrl })
    tmp.getContext('2d')!.drawImage(img, x, y, w, h, 0, 0, w, h)
    const croppedUrl = tmp.toDataURL('image/png')

    // Fabric 캔버스 리셋 후 크롭 이미지 로드
    fc.clear()
    fc.setZoom(1); zoomRef.current = 1; setZoom(1)
    fc.setWidth(Math.round(w)); fc.setHeight(Math.round(h))
    originalSizeRef.current = { width: Math.round(w), height: Math.round(h) }

    FabricImage.fromURL(croppedUrl).then(fImg => {
      fImg.set({ selectable: false, evented: false })
      fc.backgroundImage = fImg
      fc.renderAll()
    })
    setTool('select')
  }, [cropSel, pushUndo, snapshotNow])


  // ─── 크롭 취소 ───────────────────────────────────────────────────────────────
  const cancelCrop = useCallback(() => {
    const fc = fabricRef.current
    if (!fc) return
    if (cropRectRef.current) { fc.remove(cropRectRef.current); cropRectRef.current = null; fc.renderAll() }
    setCropSel(null)
  }, [])

  // ─── 팔레트 추출 ─────────────────────────────────────────────────────────────
  const extractPalette = useCallback(() => {
    const canvasEl = canvasRef.current
    if (!canvasEl) return
    const ctx2d = canvasEl.getContext('2d')!
    const { width, height } = canvasEl
    const imageData = ctx2d.getImageData(0, 0, width, height)
    const colors = medianCut(imageData.data, 10)
    setPalette(colors)
    setShowPalettePanel(true)
  }, [])

  // ─── ASE 팔레트 저장 ──────────────────────────────────────────────────────────
  const saveASE = useCallback(() => {
    if (palette.length === 0) return
    const tabUrl = capture?.tabUrl ?? ''
    const siteName = tabUrl
      ? tabUrl.replace(/^https?:\/\//, '').split('?')[0].split('#')[0]
          .replace(/\/$/, '').replace(/[\\/:*?"<>|\s]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '')
      : generateFilename('{datetime}')
    const blob = buildASE(palette, tabUrl || 'uriScreenShot Palette')
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${siteName || 'palette'}.ase`
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }, [palette, capture])

  // 페이지 정보(타이틀 + URL + QR + 팔레트) 하단 합성
  const addPageInfo = useCallback(async () => {
    const fc = fabricRef.current
    if (!fc || !capture) return
    const url = capture.tabUrl || ''
    const title = capture.tabTitle || ''
    if (!url) { alert('페이지 URL 정보가 없습니다.'); return }
    pushUndo(snapshotNow())

    const { toDataURL } = await import('qrcode')

    // 현재 캔버스 이미지를 원본 해상도로 추출
    const currentDataUrl = fc.toDataURL({ format: 'png', multiplier: 1 / zoomRef.current })

    const cw = fc.width! / zoomRef.current
    const ch = fc.height! / zoomRef.current

    // 여백/하단 섹션 크기 계산
    const pad = Math.round(Math.max(16, Math.min(cw * 0.025, 40)))
    const fs = Math.round(Math.max(11, Math.min(cw * 0.013, 16)))
    const lineH = Math.round(fs * 1.6)

    // 팔레트 영역 높이 (있을 때만)
    const hasPalette = palette.length > 0
    const swatchSize = Math.round(Math.max(10, Math.min(fs * 1.4, 18)))
    const paletteRowH = hasPalette ? swatchSize + Math.round(pad * 0.6) : 0

    const baseBottomH = Math.round(Math.max(100, Math.min(cw * 0.14, 180)))
    const bottomH = baseBottomH + paletteRowH
    const qrSize = baseBottomH - pad * 2

    // QR코드 생성
    const qrDataUrl = await toDataURL(url, {
      width: qrSize * 2, margin: 1,
      color: { dark: '#222222', light: '#fffef5' },
    })

    // 합성 캔버스 생성
    const comp = document.createElement('canvas')
    comp.width = cw + pad * 2
    comp.height = ch + pad + bottomH
    const ctx = comp.getContext('2d')!

    // 배경 (따뜻한 화이트)
    ctx.fillStyle = '#fffef5'
    ctx.fillRect(0, 0, comp.width, comp.height)

    // 이미지 그림자
    ctx.shadowColor = 'rgba(0,0,0,0.18)'
    ctx.shadowBlur = pad
    ctx.shadowOffsetY = 4

    // 스크린샷
    const img = new Image()
    await new Promise<void>(res => { img.onload = () => res(); img.src = currentDataUrl })
    ctx.drawImage(img, pad, pad, cw, ch)

    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0

    // 구분선
    ctx.strokeStyle = '#e0ddd0'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(pad, ch + pad)
    ctx.lineTo(comp.width - pad, ch + pad)
    ctx.stroke()

    // QR코드 (baseBottomH 기준으로 중앙 배치)
    const qrImg = new Image()
    await new Promise<void>(res => { qrImg.onload = () => res(); qrImg.src = qrDataUrl })
    const qrX = comp.width - pad - qrSize
    const qrY = ch + pad + Math.round((baseBottomH - qrSize) / 2)
    ctx.drawImage(qrImg, qrX, qrY, qrSize, qrSize)

    // 텍스트 (타이틀 + URL)
    const maxTextW = qrX - pad * 2
    const textContentH = lineH * 2
    const textY = ch + pad + Math.round((baseBottomH - textContentH) / 2) + fs

    ctx.fillStyle = '#1a1a1a'
    ctx.font = `bold ${fs}px -apple-system, "Segoe UI", sans-serif`
    ctx.fillText(truncateText(ctx, title, maxTextW), pad, textY)

    ctx.fillStyle = '#777777'
    ctx.font = `${Math.round(fs * 0.85)}px -apple-system, "Segoe UI", sans-serif`
    ctx.fillText(truncateText(ctx, url, maxTextW), pad, textY + lineH)

    // 팔레트 컬러 스와치
    if (hasPalette) {
      const swatchTop = ch + pad + baseBottomH + Math.round((paletteRowH - swatchSize) / 2)
      const swatchGap = Math.round(swatchSize * 0.35)
      const maxSwatches = Math.floor((comp.width - pad * 2) / (swatchSize + swatchGap))
      const swatchColors = palette.slice(0, maxSwatches)

      // 팔레트 구분선
      ctx.strokeStyle = '#e8e4d8'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(pad, ch + pad + baseBottomH)
      ctx.lineTo(comp.width - pad, ch + pad + baseBottomH)
      ctx.stroke()

      swatchColors.forEach((hex, i) => {
        const sx = pad + i * (swatchSize + swatchGap)
        const r = swatchSize / 2
        ctx.fillStyle = hex
        ctx.beginPath()
        ctx.arc(sx + r, swatchTop + r, r, 0, Math.PI * 2)
        ctx.fill()
        ctx.strokeStyle = 'rgba(0,0,0,0.12)'
        ctx.lineWidth = 0.8
        ctx.stroke()
      })
    }

    const composedDataUrl = comp.toDataURL('image/png')

    // Fabric.js 캔버스를 합성 이미지로 교체
    const { FabricImage } = await import('fabric')
    const newScale = Math.min(
      (window.innerWidth - 40) / comp.width,
      (window.innerHeight - 120) / comp.height,
      1,
    )
    const newW = Math.round(comp.width * newScale)
    const newH = Math.round(comp.height * newScale)

    fc.clear()
    fc.setWidth(newW)
    fc.setHeight(newH)
    fc.setZoom(newScale)
    originalSizeRef.current = { width: newW, height: newH }
    zoomRef.current = newScale
    setZoom(newScale)

    FabricImage.fromURL(composedDataUrl).then(fImg => {
      fImg.set({ scaleX: 1, scaleY: 1, selectable: false, evented: false })
      fc.backgroundImage = fImg
      fc.renderAll()
    })
  }, [capture, palette, pushUndo, snapshotNow])

  // 텍스트 추가
  const addText = useCallback(async () => {
    const { IText } = await import('fabric')
    const fc = fabricRef.current
    if (!fc) return
    pushUndo(snapshotNow())
    const text = new IText('텍스트 입력', {
      left: 100, top: 100, fill: color, fontSize: 20, fontFamily: 'sans-serif',
    })
    fc.add(text)
    fc.setActiveObject(text)
    text.enterEditing()
    fc.renderAll()
  }, [color, pushUndo, snapshotNow])

  // 박스 추가
  const addRect = useCallback(async () => {
    const { Rect } = await import('fabric')
    const fc = fabricRef.current
    if (!fc) return
    pushUndo(snapshotNow())
    const rect = new Rect({
      left: 100, top: 100, width: 150, height: 100,
      fill: 'transparent', stroke: color, strokeWidth,
    })
    fc.add(rect)
    fc.setActiveObject(rect)
    fc.renderAll()
  }, [color, strokeWidth, pushUndo, snapshotNow])

  // 전체 편집 초기화 (배경 이미지 유지, 레이어 전체 삭제)
  const clearAll = useCallback(() => {
    const fc = fabricRef.current
    if (!fc) return
    const objects = fc.getObjects()
    if (objects.length === 0) return
    pushUndo(snapshotNow())
    objects.forEach(obj => fc.remove(obj))
    fc.discardActiveObject()
    fc.renderAll()
  }, [pushUndo, snapshotNow])

  // 선택 삭제
  const deleteSelected = useCallback(() => {
    const fc = fabricRef.current
    if (!fc) return
    const active = fc.getActiveObjects()
    if (active.length === 0) return
    pushUndo(snapshotNow())
    active.forEach(obj => fc.remove(obj))
    fc.discardActiveObject()
    fc.renderAll()
  }, [pushUndo, snapshotNow])

  // 파일 다운로드 헬퍼 (<a download> 방식 - SW 경유 없이 파일명 정상 동작)
  const downloadFile = useCallback((dataUrl: string, filename: string) => {
    const a = document.createElement('a')
    a.href = dataUrl
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }, [])

  const buildExportFilename = useCallback((preset: 'bug' | 'design' | 'document' | 'archive', ext: 'png' | 'jpg' | 'pdf') => {
    const site = (capture?.tabUrl ?? '')
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split(/[/?#]/)[0]
      .replace(/[^a-zA-Z0-9.-]/g, '_')
      || 'capture'
    const title = (capture?.tabTitle ?? '')
      .trim()
      .replace(/\s+/g, '_')
      .replace(/[\\/:*?"<>|]/g, '')
      .slice(0, 40)
    const stem = [preset, site, title, generateFilename('{datetime}')].filter(Boolean).join('_')
    return `${stem}.${ext}`
  }, [capture?.tabTitle, capture?.tabUrl])

  // PNG 다운로드
  const downloadPng = useCallback(() => {
    const fc = fabricRef.current
    if (!fc) return
    const dataUrl = fc.toDataURL({ format: 'png', multiplier: 1 / zoomRef.current })
    downloadFile(dataUrl, generateFilename('{datetime}') + '.png')
  }, [downloadFile])

  // JPEG 다운로드
  const downloadJpeg = useCallback(() => {
    const fc = fabricRef.current
    if (!fc) return
    const dataUrl = fc.toDataURL({ format: 'jpeg', quality: 0.9, multiplier: 1 / zoomRef.current })
    downloadFile(dataUrl, generateFilename('{datetime}') + '.jpg')
  }, [downloadFile])

  const exportPresetPng = useCallback((preset: 'bug' | 'design') => {
    const fc = fabricRef.current
    if (!fc) return
    const dataUrl = fc.toDataURL({ format: 'png', multiplier: 1 / zoomRef.current })
    downloadFile(dataUrl, buildExportFilename(preset, 'png'))
  }, [buildExportFilename, downloadFile])

  const exportPresetJpeg = useCallback(() => {
    const fc = fabricRef.current
    if (!fc) return
    const dataUrl = fc.toDataURL({ format: 'jpeg', quality: 0.9, multiplier: 1 / zoomRef.current })
    downloadFile(dataUrl, buildExportFilename('archive', 'jpg'))
  }, [buildExportFilename, downloadFile])

  // 클립보드 복사
  const copyToClipboard = useCallback(async () => {
    const fc = fabricRef.current
    if (!fc) return
    const dataUrl = fc.toDataURL({ format: 'png', multiplier: 1 / zoomRef.current })
    const blob = await (await fetch(dataUrl)).blob()
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': blob })
    ])
    alert('클립보드에 복사됐습니다.')
  }, [])

  // PDF 내보내기 (jsPDF.save() 내부적으로 blob URL 사용 → 파일명 정상)
  const downloadPdf = useCallback(async () => {
    const fc = fabricRef.current
    if (!fc) return
    const { jsPDF } = await import('jspdf')
    const dataUrl = fc.toDataURL({ format: 'jpeg', quality: 0.9, multiplier: 1 / zoomRef.current })
    const { width, height } = originalSizeRef.current
    const orientation = width > height ? 'l' : 'p'
    const pdf = new jsPDF({ orientation, unit: 'px', format: [width, height] })
    pdf.addImage(dataUrl, 'JPEG', 0, 0, width, height)
    pdf.save(generateFilename('{datetime}') + '.pdf')
  }, [])  // jsPDF.save()는 내부에서 blob URL 생성하므로 파일명 정상 동작

  const exportPresetPdf = useCallback(async () => {
    const fc = fabricRef.current
    if (!fc) return
    const { jsPDF } = await import('jspdf')
    const dataUrl = fc.toDataURL({ format: 'jpeg', quality: 0.9, multiplier: 1 / zoomRef.current })
    const { width, height } = originalSizeRef.current
    const orientation = width > height ? 'l' : 'p'
    const pdf = new jsPDF({ orientation, unit: 'px', format: [width, height] })
    pdf.setProperties({
      title: capture?.tabTitle || 'uriScreenShot Export',
      subject: 'Document export',
      author: 'uriScreenShot',
      keywords: `${capture?.tabUrl ?? ''}`.slice(0, 255),
    })
    pdf.addImage(dataUrl, 'JPEG', 0, 0, width, height)
    pdf.save(buildExportFilename('document', 'pdf'))
  }, [buildExportFilename, capture?.tabTitle, capture?.tabUrl])

  const copyShareSummary = useCallback(async () => {
    const summary = [
      `제목: ${capture?.tabTitle || 'Untitled'}`,
      `URL: ${capture?.tabUrl || '-'}`,
      `크기: ${originalSizeRef.current.width} x ${originalSizeRef.current.height}px`,
      `캡처 시각: ${new Date().toLocaleString('ko-KR')}`,
    ].join('\n')
    await navigator.clipboard.writeText(summary)
    alert('캡처 메타데이터를 복사했습니다.')
  }, [capture?.tabTitle, capture?.tabUrl])

  const copyMarkdownSummary = useCallback(async () => {
    const title = capture?.tabTitle || 'Untitled'
    const url = capture?.tabUrl || ''
    const markdown = [
      `## ${title}`,
      url ? `[원본 페이지](${url})` : '',
      '',
      `- 크기: ${originalSizeRef.current.width} x ${originalSizeRef.current.height}px`,
      `- 캡처 시각: ${new Date().toLocaleString('ko-KR')}`,
    ].filter(Boolean).join('\n')
    await navigator.clipboard.writeText(markdown)
    alert('마크다운 요약을 복사했습니다.')
  }, [capture?.tabTitle, capture?.tabUrl])

  const toolBtns: { id: EditorTool; label: string; icon: React.ReactNode; action?: () => void }[] = [
    { id: 'select',     label: '선택',    icon: <IcoSelect /> },
    { id: 'hand',       label: '손',      icon: <IcoHand /> },
    { id: 'zoom',       label: '줌',      icon: <IcoZoomTool /> },
    { id: 'pen',        label: '펜',      icon: <IcoPen /> },
    { id: 'text',       label: '텍스트',  icon: <IcoText />,       action: addText },
    { id: 'rect',       label: '박스',    icon: <IcoRect />,       action: addRect },
    { id: 'arrow',      label: '화살표',     icon: <IcoArrowDraw /> },
    { id: 'ellipse',    label: '타원',       icon: <IcoEllipse /> },
    { id: 'highlight',  label: '형광펜',     icon: <IcoHighlight /> },
    { id: 'number',     label: '번호스티커', icon: <IcoNumber /> },
    { id: 'mosaic',     label: '모자이크',   icon: <IcoMosaic /> },
    { id: 'crop',       label: '크롭',       icon: <IcoCrop /> },
    { id: 'eyedropper', label: '스포이드',   icon: <IcoEyedropper /> },
    { id: 'fill',       label: '페인트통',   icon: <IcoFill /> },
  ]

  // ── 왼쪽 사이드바 툴 버튼 ──
  const psBtn = (id: EditorTool, label: string, icon: React.ReactNode, action?: () => void) => (
    <button
      key={id}
      title={label}
      onClick={() => { setTool(id); action?.() }}
      style={{
        width: 40, height: 36, padding: 0, border: 'none', cursor: 'pointer', borderRadius: 4,
        background: tool === id ? '#3c3c3c' : 'transparent',
        color: tool === id ? '#e0e0e0' : '#8a8a8a',
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        outline: tool === id ? '1px solid #5a5a5a' : 'none',
        outlineOffset: -1,
      }}
    >
      {icon}
    </button>
  )

  if (!capture) {
    const isDl = new URLSearchParams(location.search).has('dl')
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#888' }}>
        {isDl ? '⬇️ 다운로드 중...' : '캡처 데이터를 불러오는 중...'}
      </div>
    )
  }


  // 색상 피커 인라인 컴포넌트
  const ColorPicker = () => (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <div style={{ width: 22, height: 22, borderRadius: 3, background: color, border: '1.5px solid #5a5a5a', cursor: 'pointer', boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.5)' }} />
      <input type="color" value={color} onChange={e => setColor(e.target.value)}
        style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', padding: 0, border: 'none', width: '100%', height: '100%' }} />
    </div>
  )

  const drawingTools = ['pen', 'rect', 'ellipse', 'arrow', 'highlight']

  return (
    <>
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#1e1e1e', fontFamily: '-apple-system,"Segoe UI",sans-serif', color: '#c8c8c8' }}>

      {/* ── 컨텍스트 옵션바 (현재 도구에 따라 변경) ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 0,
        padding: '0 0 0 8px', height: 48, flexShrink: 0,
        background: '#323232', borderBottom: '1px solid #1a1a1a',
        boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
      }}>
        {/* 현재 도구명 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, width: 106, paddingRight: 10, borderRight: '1px solid #484848', flexShrink: 0, marginRight: 10 }}>
          <span style={{ color: '#b0b0b0', display: 'flex', alignItems: 'center' }}>{toolBtns.find(b => b.id === tool)?.icon}</span>
          <span style={{ fontSize: 11, color: '#909090', whiteSpace: 'nowrap' }}>{toolBtns.find(b => b.id === tool)?.label}</span>
        </div>

        {/* 색상 (그리기/채우기 도구) */}
        {(drawingTools.includes(tool) || tool === 'text' || tool === 'number' || tool === 'fill') && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingRight: 10, borderRight: '1px solid #484848', marginRight: 10 }}>
            <span style={{ fontSize: 10, color: '#686868' }}>색상</span>
            <ColorPicker />
            <span style={{ fontSize: 10, color: '#505050', fontFamily: 'monospace', letterSpacing: '0.3px' }}>{color.toUpperCase()}</span>
          </div>
        )}

        {/* 두께 (드로잉/도형) */}
        {drawingTools.includes(tool) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingRight: 10, borderRight: '1px solid #484848', marginRight: 10 }}>
            <span style={{ fontSize: 10, color: '#686868' }}>두께</span>
            <input type="range" min={1} max={10} value={strokeWidth}
              onChange={e => setStrokeWidth(Number(e.target.value))}
              style={{ width: 80, accentColor: '#4d8ecf' }} />
            <span style={{ fontSize: 10, color: '#909090', fontFamily: 'monospace', width: 20 }}>{strokeWidth}px</span>
          </div>
        )}

        {/* 번호 스티커 - 리셋 */}
        {tool === 'number' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingRight: 10, borderRight: '1px solid #484848', marginRight: 10 }}>
            <button onClick={() => { stickerNumRef.current = 1 }}
              style={{ padding: '3px 10px', background: '#3c3c3c', border: '1px solid #555', borderRadius: 3, color: '#c0c0c0', fontSize: 10, cursor: 'pointer' }}>
              번호 리셋
            </button>
          </div>
        )}

        {/* 힌트 */}
        {(tool === 'select' || tool === 'crop' || tool === 'mosaic' || tool === 'eyedropper' || tool === 'hand' || tool === 'zoom') && (
          <span style={{ fontSize: 10, color: '#505050', paddingRight: 10 }}>
            {tool === 'select' && '오브젝트를 클릭·드래그하여 선택, Del로 삭제'}
            {tool === 'crop' && '드래그로 영역 선택 → 크롭 또는 지우기'}
            {tool === 'mosaic' && '드래그로 블러 처리할 영역 선택'}
            {tool === 'eyedropper' && '클릭하여 색상 추출 → 현재 색상에 적용'}
            {tool === 'hand' && '드래그하여 캔버스를 이동'}
            {tool === 'zoom' && '클릭하여 확대, Shift 또는 Alt+클릭으로 축소'}
          </span>
        )}

        <div style={{ flex: 1 }} />

        {/* 편집 액션 그룹 */}
        <div style={{ display: 'flex', alignItems: 'center', borderLeft: '1px solid #484848', borderRight: '1px solid #484848' }}>
          <button onClick={undo} disabled={!canUndo} title="되돌리기 Ctrl+Z" style={{ ...psTopBtn, opacity: canUndo ? 1 : 0.22 }}><IcoUndo /></button>
          <button onClick={redo} disabled={!canRedo} title="앞으로 Ctrl+Y" style={{ ...psTopBtn, opacity: canRedo ? 1 : 0.22 }}><IcoRedo /></button>
          <button onClick={deleteSelected} title="선택 삭제 Del" style={psTopBtn}><IcoTrash /></button>
          <button onClick={clearAll} title="전체 초기화" style={{ ...psTopBtn, color: '#b05050' }}><IcoClearAll /></button>
        </div>

        {/* 이미지 편집 */}
        <div style={{ display: 'flex', alignItems: 'center', borderRight: '1px solid #484848' }}>
          <button onClick={addPageInfo} title="페이지 정보 + QR + 팔레트" style={psTopBtn}><IcoPageInfo /></button>
          <button onClick={rotate90} title="90° 회전" style={psTopBtn}><IcoRotate90 /></button>
          <button onClick={() => { const { width, height } = originalSizeRef.current; resizeRatioRef.current = width / height; setResizeW(width); setResizeH(height); setShowResizePanel(p => !p); setShowAdjustPanel(false); setShowWatermarkPanel(false) }} title="크기 조절" style={{ ...psTopBtn, background: showResizePanel ? '#3a3a2a' : 'transparent' }}><IcoResize /></button>
          <button onClick={() => { setShowAdjustPanel(p => !p); setShowResizePanel(false); setShowWatermarkPanel(false) }} title="밝기/대비" style={{ ...psTopBtn, background: showAdjustPanel ? '#3a3a2a' : 'transparent' }}><IcoBrightness /></button>
          <button onClick={() => { setShowWatermarkPanel(p => !p); setShowResizePanel(false); setShowAdjustPanel(false) }} title="워터마크" style={{ ...psTopBtn, background: showWatermarkPanel ? '#3a3a2a' : 'transparent' }}><IcoWatermark /></button>
        </div>

        {/* 저장/내보내기 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button onClick={copyToClipboard} title="클립보드 복사" style={psTopBtn}><IcoClipboard /></button>
          <button
            ref={exportBtnRef}
            onClick={() => {
              if (!showExportPanel && exportBtnRef.current) {
                const r = exportBtnRef.current.getBoundingClientRect()
                setExportPanelPos({ top: r.bottom + 4, right: window.innerWidth - r.right })
              }
              setShowExportPanel(p => !p)
            }}
            title="빠른 내보내기"
            style={{ ...psTopBtn, background: showExportPanel ? '#2f3a55' : 'transparent' }}
          >
            <IcoShare />
          </button>
          <button ref={paletteBtnRef} onClick={() => { if (!showPalettePanel && paletteBtnRef.current) { const r = paletteBtnRef.current.getBoundingClientRect(); setPalettePanelPos({ top: r.bottom + 4, right: window.innerWidth - r.right }) } setShowPalettePanel(p => !p) }} title="팔레트 추출" style={{ ...psTopBtn, background: showPalettePanel ? '#2a3a2a' : 'transparent' }}><IcoPalette /></button>
          <button onClick={downloadPng} title="PNG 저장" style={{ ...psTopBtn, gap: 2 }}><IcoDownload /><span style={{ fontSize: 8, fontWeight: 700, color: '#70c090' }}>PNG</span></button>
          <button onClick={downloadJpeg} title="JPG 저장" style={{ ...psTopBtn, gap: 2 }}><IcoDownload /><span style={{ fontSize: 8, fontWeight: 700, color: '#70a0c0' }}>JPG</span></button>
          <button onClick={downloadPdf} title="PDF 저장" style={{ ...psTopBtn, gap: 2 }}><IcoDownload /><span style={{ fontSize: 8, fontWeight: 700, color: '#a080c0' }}>PDF</span></button>
        </div>
        <div style={{ width: 1, height: 24, background: '#484848' }} />
        <button onClick={() => window.close()} title="닫기" style={{ ...psTopBtn, width: 40, color: '#b05050' }}><IcoClose /></button>
      </div>

      {/* ── 메인 (왼쪽 패널 + 캔버스) ── */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {/* ── 왼쪽 툴 패널 ── */}
        <div style={{
          width: 44, flexShrink: 0,
          background: '#2b2b2b',
          borderRight: '1px solid #1a1a1a',
          boxShadow: '2px 0 6px rgba(0,0,0,0.3)',
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          padding: '8px 0', gap: 0, overflowY: 'auto',
        }}>
          {psBtn('select',     '선택 [V]',        <IcoSelect />)}
          {psBtn('hand',       '손 [Space]',      <IcoHand />)}
          {psBtn('zoom',       '줌 [Z]',          <IcoZoomTool />)}
          <div style={psSepH} />
          {psBtn('pen',        '펜 [P]',           <IcoPen />)}
          {psBtn('highlight',  '형광펜 [H]',       <IcoHighlight />)}
          <div style={psSepH} />
          {psBtn('rect',       '박스 [R]',         <IcoRect />)}
          {psBtn('ellipse',    '타원 [E]',         <IcoEllipse />)}
          {psBtn('arrow',      '화살표 [A]',       <IcoArrowDraw />)}
          <div style={psSepH} />
          {psBtn('text',       '텍스트 [T]',       <IcoText />, addText)}
          {psBtn('number',     '번호스티커 [N]',   <IcoNumber />)}
          <div style={psSepH} />
          {psBtn('mosaic',     '모자이크 [M]',     <IcoMosaic />)}
          {psBtn('fill',       '페인트통 [F]',     <IcoFill />)}
          {psBtn('eyedropper', '스포이드 [I]',     <IcoEyedropper />)}
          <div style={psSepH} />
          {psBtn('crop',       '크롭 [C]',         <IcoCrop />)}

          {/* 전경색 표시 (PS 시그니처 요소) */}
          <div style={{ marginTop: 'auto', width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingBottom: 10 }}>
            <div style={psSepH} />
            <div style={{ position: 'relative', width: 32, height: 32, marginTop: 6 }} title={`전경색: ${color}`}>
              {/* 배경색 (흰색 고정) */}
              <div style={{ width: 20, height: 20, background: '#ffffff', border: '1.5px solid #666', borderRadius: 1, position: 'absolute', bottom: 0, right: 2, boxShadow: '0 1px 4px rgba(0,0,0,0.6)' }} />
              {/* 전경색 */}
              <div style={{ width: 20, height: 20, background: color, border: '1.5px solid #999', borderRadius: 1, position: 'absolute', top: 0, left: 2, cursor: 'pointer', boxShadow: '0 1px 4px rgba(0,0,0,0.6)' }} />
              <input type="color" value={color} onChange={e => setColor(e.target.value)}
                style={{ position: 'absolute', top: 0, left: 2, width: 20, height: 20, opacity: 0, cursor: 'pointer' }} />
            </div>
          </div>
        </div>

        {/* ── 캔버스 영역 ── */}
        <div
          ref={canvasWrapperRef}
          style={{
            flex: 1, overflow: 'auto', display: 'flex',
            alignItems: 'flex-start', justifyContent: 'center',
            padding: 32, position: 'relative',
            background: '#3c3c3c',
            backgroundImage: 'repeating-conic-gradient(#424242 0% 25%, #383838 0% 50%)',
            backgroundSize: '20px 20px',
          }}
        >
          <canvas ref={canvasRef} style={{
            border: 'none',
            boxShadow: '0 16px 64px rgba(0,0,0,0.9), 0 4px 16px rgba(0,0,0,0.6)',
          }} />

          {/* 크롭 확인 패널 */}
          {cropSel && (
            <div style={{
              position: 'absolute',
              left: cropSel.btnLeft + 20,
              top: cropSel.btnTop,
              display: 'flex', alignItems: 'center', gap: 6,
              background: '#2b2b2b', border: '1px solid #5a5a5a',
              borderRadius: 4, padding: '5px 10px',
              boxShadow: '0 4px 24px rgba(0,0,0,0.9)',
              zIndex: 100,
            }}>
              <span style={{ fontSize: 11, color: '#888' }}>선택 영역</span>
              <div style={{ width: 1, height: 14, background: '#4a4a4a' }} />
              <button onClick={eraseRegion} style={{ padding: '3px 8px', background: '#4a2020', border: '1px solid #6a3030', borderRadius: 3, color: '#ddd', fontSize: 11, cursor: 'pointer' }}>지우기</button>
              <button onClick={confirmCrop} style={{ padding: '3px 10px', background: '#1e5aaa', border: '1px solid #2d6fcc', borderRadius: 3, color: '#fff', fontSize: 11, cursor: 'pointer', fontWeight: 600 }}>크롭</button>
              <button onClick={cancelCrop} style={{ padding: '3px 8px', background: '#3a3a3a', border: '1px solid #5a5a5a', borderRadius: 3, color: '#aaa', fontSize: 11, cursor: 'pointer' }}>취소</button>
            </div>
          )}
        </div>
      </div>

      {/* ── 하단 상태바 ── */}
      <div style={{
        height: 22, flexShrink: 0,
        background: '#2b2b2b', borderTop: '1px solid #1a1a1a',
        display: 'flex', alignItems: 'center', padding: '0 10px', gap: 0,
        boxShadow: '0 -1px 4px rgba(0,0,0,0.3)',
      }}>
        <button onClick={() => applyZoom(zoomRef.current - 0.1)} title="축소" style={psStatusBtn}><IcoZoomOut /></button>
        <button onClick={() => applyZoom(1)} title="100%로 리셋"
          style={{ ...psStatusBtn, minWidth: 46, fontFamily: 'monospace', fontWeight: 700, fontSize: 10, color: '#b0b0b0' }}>
          {Math.round(zoom * 100)}%
        </button>
        <button onClick={() => applyZoom(zoomRef.current + 0.1)} title="확대" style={psStatusBtn}><IcoZoomIn /></button>
        <div style={{ width: 1, height: 12, background: '#484848', margin: '0 10px' }} />
        <span style={{ fontSize: 10, color: '#686868', fontFamily: 'monospace' }}>
          {originalSizeRef.current.width} × {originalSizeRef.current.height} px
        </span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: '#585858' }}>
          {toolBtns.find(b => b.id === tool)?.label}
        </span>
      </div>
    </div>

    {/* 팔레트 패널 */}
    {showPalettePanel && (
      <div style={{
        position: 'fixed', top: palettePanelPos.top, right: palettePanelPos.right,
        background: '#16213e', border: '1px solid #4A90E2', borderRadius: 10,
        padding: 16, zIndex: 2000, width: 272,
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        {/* 헤더 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <span style={{ color: '#a8b4ff', fontWeight: 700, fontSize: 13 }}>🎨 팔레트</span>
          <button onClick={() => setShowPalettePanel(false)}
            style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 2px' }}>✕</button>
        </div>

        {/* 추출 버튼 */}
        <button
          onClick={extractPalette}
          style={{ width: '100%', padding: '7px 0', background: '#1a4a2e', border: '1px solid #2d6a4f', borderRadius: 6, color: '#7ecfa0', fontSize: 12, cursor: 'pointer', marginBottom: 12, fontWeight: 600 }}
        >
          ▶ 이미지에서 색상 추출
        </button>

        {palette.length > 0 && (
          <>
            {/* 색상 그리드 */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6, marginBottom: 12 }}>
              {palette.map((c, i) => (
                <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                  <button
                    title={c}
                    onClick={() => setColor(c)}
                    style={{
                      width: 40, height: 40, borderRadius: 6, background: c, cursor: 'pointer',
                      border: color === c ? '3px solid #fff' : '2px solid #444',
                      boxShadow: color === c ? `0 0 8px ${c}` : '0 2px 4px rgba(0,0,0,0.4)',
                      padding: 0, transition: 'transform 0.1s',
                    }}
                  />
                  <span style={{ fontSize: 9, color: '#888', fontFamily: 'monospace', letterSpacing: '-0.3px' }}>{c}</span>
                </div>
              ))}
            </div>

            {/* 현재 선택 색상 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: '#0f0f23', borderRadius: 6, marginBottom: 12 }}>
              <div style={{ width: 32, height: 32, borderRadius: 6, background: color, border: '2px solid #555', flexShrink: 0 }} />
              <div>
                <div style={{ fontSize: 11, color: '#888' }}>현재 색상</div>
                <div style={{ fontSize: 13, color: '#e0e0e0', fontFamily: 'monospace', fontWeight: 600 }}>{color.toUpperCase()}</div>
              </div>
            </div>

            {/* ASE 저장 */}
            <button
              onClick={saveASE}
              style={{ width: '100%', padding: '8px 0', background: '#4A90E2', border: 'none', borderRadius: 6, color: '#fff', fontSize: 12, cursor: 'pointer', fontWeight: 700, letterSpacing: '0.3px' }}
            >
              💾 ASE 저장 (Adobe 호환 팔레트)
            </button>
          </>
        )}
      </div>
    )}
    {showExportPanel && (
      <div style={{
        position: 'fixed', top: exportPanelPos.top, right: exportPanelPos.right,
        background: '#16213e', border: '1px solid #4A90E2', borderRadius: 10,
        padding: 16, zIndex: 2000, width: 300,
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <span style={{ color: '#a8b4ff', fontWeight: 700, fontSize: 13 }}>공유 / 내보내기</span>
          <button onClick={() => setShowExportPanel(false)}
            style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 2px' }}>✕</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
          <button onClick={() => exportPresetPng('bug')} style={exportPresetBtnStyle}>버그 리포트 PNG</button>
          <button onClick={() => exportPresetPng('design')} style={exportPresetBtnStyle}>디자인 피드백 PNG</button>
          <button onClick={exportPresetPdf} style={exportPresetBtnStyle}>문서 PDF</button>
          <button onClick={exportPresetJpeg} style={exportPresetBtnStyle}>보관 JPG</button>
        </div>

        <div style={{ display: 'grid', gap: 8 }}>
          <button onClick={copyShareSummary} style={exportActionBtnStyle}>캡처 메타데이터 복사</button>
          <button onClick={copyMarkdownSummary} style={exportActionBtnStyle}>마크다운 요약 복사</button>
        </div>
      </div>
    )}
    {/* 리사이즈 패널 */}
    {showResizePanel && (
      <div style={{ position: 'fixed', top: 60, right: 16, background: '#16213e', border: '1px solid #4A90E2', borderRadius: 10, padding: 16, zIndex: 2000, width: 220, boxShadow: '0 8px 32px rgba(0,0,0,0.7)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <span style={{ color: '#a8b4ff', fontWeight: 700, fontSize: 13 }}>↔ 크기 조절</span>
          <button onClick={() => setShowResizePanel(false)} style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: 16 }}>✕</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ fontSize: 12, color: '#aaa' }}>
            가로 (px)
            <input type="number" value={resizeW}
              onChange={e => {
                const w = Math.max(1, Number(e.target.value))
                setResizeW(w)
                if (resizeLocked) setResizeH(Math.max(1, Math.round(w / resizeRatioRef.current)))
              }}
              min={1}
              style={{ display: 'block', width: '100%', background: '#0f0f23', border: '1px solid #444', color: '#e0e0e0', padding: '4px 8px', borderRadius: 4, fontSize: 13, marginTop: 4, boxSizing: 'border-box' }} />
          </label>
          {/* 비율 연결 버튼 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 4 }}>
            <button
              onClick={() => setResizeLocked(l => !l)}
              title={resizeLocked ? '비율 잠금 해제' : '비율 잠금'}
              style={{ width: 26, height: 26, padding: 0, background: resizeLocked ? '#4A90E2' : '#2a3f6f', border: 'none', borderRadius: 4, cursor: 'pointer', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
            >
              <IcoLock locked={resizeLocked} />
            </button>
            <span style={{ fontSize: 10, color: resizeLocked ? '#7ab4ff' : '#666' }}>
              {resizeLocked ? '비율 유지' : '비율 해제'}
            </span>
          </div>
          <label style={{ fontSize: 12, color: '#aaa' }}>
            세로 (px)
            <input type="number" value={resizeH}
              onChange={e => {
                const h = Math.max(1, Number(e.target.value))
                setResizeH(h)
                if (resizeLocked) setResizeW(Math.max(1, Math.round(h * resizeRatioRef.current)))
              }}
              min={1}
              style={{ display: 'block', width: '100%', background: '#0f0f23', border: '1px solid #444', color: '#e0e0e0', padding: '4px 8px', borderRadius: 4, fontSize: 13, marginTop: 4, boxSizing: 'border-box' }} />
          </label>
          <button onClick={() => applyResize(resizeW, resizeH)}
            style={{ marginTop: 4, padding: '8px 0', background: '#4A90E2', border: 'none', borderRadius: 6, color: '#fff', fontSize: 12, cursor: 'pointer', fontWeight: 700 }}>
            적용
          </button>
        </div>
      </div>
    )}

    {/* 밝기/대비 패널 */}
    {showAdjustPanel && (
      <div style={{ position: 'fixed', top: 60, right: 16, background: '#16213e', border: '1px solid #4A90E2', borderRadius: 10, padding: 16, zIndex: 2000, width: 220, boxShadow: '0 8px 32px rgba(0,0,0,0.7)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <span style={{ color: '#a8b4ff', fontWeight: 700, fontSize: 13 }}>☀ 밝기 / 대비</span>
          <button onClick={() => setShowAdjustPanel(false)} style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: 16 }}>✕</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ fontSize: 12, color: '#aaa' }}>
            밝기 {adjustBrightness}%
            <input type="range" min={10} max={200} step={5} value={adjustBrightness}
              onChange={e => setAdjustBrightness(Number(e.target.value))}
              style={{ display: 'block', width: '100%', marginTop: 4 }} />
          </label>
          <label style={{ fontSize: 12, color: '#aaa' }}>
            대비 {adjustContrast}%
            <input type="range" min={10} max={200} step={5} value={adjustContrast}
              onChange={e => setAdjustContrast(Number(e.target.value))}
              style={{ display: 'block', width: '100%', marginTop: 4 }} />
          </label>
          <button onClick={() => applyAdjust(adjustBrightness, adjustContrast)}
            style={{ padding: '8px 0', background: '#4A90E2', border: 'none', borderRadius: 6, color: '#fff', fontSize: 12, cursor: 'pointer', fontWeight: 700 }}>
            적용
          </button>
          <button onClick={() => { setAdjustBrightness(100); setAdjustContrast(100) }}
            style={{ padding: '5px 0', background: '#333', border: 'none', borderRadius: 6, color: '#aaa', fontSize: 11, cursor: 'pointer' }}>
            초기화
          </button>
        </div>
      </div>
    )}

    {/* 워터마크 패널 */}
    {showWatermarkPanel && (
      <div style={{ position: 'fixed', top: 60, right: 16, background: '#16213e', border: '1px solid #4A90E2', borderRadius: 10, padding: 16, zIndex: 2000, width: 240, boxShadow: '0 8px 32px rgba(0,0,0,0.7)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <span style={{ color: '#a8b4ff', fontWeight: 700, fontSize: 13 }}>© 워터마크</span>
          <button onClick={() => setShowWatermarkPanel(false)} style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: 16 }}>✕</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ fontSize: 12, color: '#aaa' }}>
            텍스트
            <input type="text" value={watermarkText} onChange={e => setWatermarkText(e.target.value)}
              style={{ display: 'block', width: '100%', background: '#0f0f23', border: '1px solid #444', color: '#e0e0e0', padding: '4px 8px', borderRadius: 4, fontSize: 13, marginTop: 4, boxSizing: 'border-box' }} />
          </label>
          <div style={{ fontSize: 12, color: '#aaa' }}>
            위치
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginTop: 4 }}>
              {(['topleft', 'topright', 'bottomleft', 'bottomright'] as const).map(pos => (
                <button key={pos} onClick={() => setWatermarkPos(pos)}
                  style={{ padding: '4px', background: watermarkPos === pos ? '#4A90E2' : '#2a3f6f', border: 'none', borderRadius: 4, color: '#fff', fontSize: 10, cursor: 'pointer' }}>
                  {pos === 'topleft' ? '↖ 좌상' : pos === 'topright' ? '↗ 우상' : pos === 'bottomleft' ? '↙ 좌하' : '↘ 우하'}
                </button>
              ))}
              <button onClick={() => setWatermarkPos('center')}
                style={{ gridColumn: '1 / -1', padding: '4px', background: watermarkPos === 'center' ? '#4A90E2' : '#2a3f6f', border: 'none', borderRadius: 4, color: '#fff', fontSize: 10, cursor: 'pointer' }}>
                ⊙ 중앙
              </button>
            </div>
          </div>
          <label style={{ fontSize: 12, color: '#aaa' }}>
            불투명도 {watermarkOpacity}%
            <input type="range" min={10} max={100} step={5} value={watermarkOpacity}
              onChange={e => setWatermarkOpacity(Number(e.target.value))}
              style={{ display: 'block', width: '100%', marginTop: 4 }} />
          </label>
          <button onClick={() => applyWatermark(watermarkText, watermarkPos, watermarkOpacity)}
            style={{ padding: '8px 0', background: '#4A90E2', border: 'none', borderRadius: 6, color: '#fff', fontSize: 12, cursor: 'pointer', fontWeight: 700 }}>
            적용
          </button>
        </div>
      </div>
    )}
    </>
  )
}

// 상단 옵션바 버튼 (Photoshop 스타일 - 경계 없는 플랫)
const psTopBtn: React.CSSProperties = {
  width: 30, height: 48, padding: 0, border: 'none', cursor: 'pointer', borderRadius: 0,
  background: 'transparent', color: '#909090',
  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, gap: 2,
}
// 하단 상태바 버튼
const psStatusBtn: React.CSSProperties = {
  height: 18, padding: '0 4px', border: 'none', cursor: 'pointer', borderRadius: 2,
  background: 'transparent', color: '#787878',
  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10,
}
// 사이드바 수평 구분선
const psSepH: React.CSSProperties = { width: 28, height: 1, background: '#3a3a3a', margin: '5px 0', flexShrink: 0 }
// 구버전 호환용 (미사용 선언 유지)
const vDivStyle: React.CSSProperties = { width: 1, height: 18, background: '#484848', flexShrink: 0, margin: '0 2px' }
const hDivStyle: React.CSSProperties = { width: 28, height: 1, background: '#3a3a3a', margin: '4px 0', flexShrink: 0 }
const tbBtnStyle: React.CSSProperties = { width: 26, height: 26, padding: 0, border: 'none', cursor: 'pointer', borderRadius: 4, background: 'transparent', color: '#8080a8', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }

const actionBtnStyle: React.CSSProperties = {
  padding: '4px 10px', borderRadius: 4, border: 'none', cursor: 'pointer',
  background: '#2a3f6f', color: '#fff', fontSize: 12,
}

const exportPresetBtnStyle: React.CSSProperties = {
  padding: '8px 10px',
  borderRadius: 6,
  border: '1px solid #2f5b9a',
  background: '#203352',
  color: '#dfe9ff',
  fontSize: 11,
  cursor: 'pointer',
  fontWeight: 700,
  lineHeight: 1.3,
}

const exportActionBtnStyle: React.CSSProperties = {
  padding: '9px 10px',
  borderRadius: 6,
  border: '1px solid #2d6a4f',
  background: '#173629',
  color: '#bfe9cf',
  fontSize: 11,
  cursor: 'pointer',
  fontWeight: 700,
}

const iconBtnStyle: React.CSSProperties = {
  width: 30, height: 28, padding: 0, borderRadius: 4, border: 'none', cursor: 'pointer',
  background: '#2a3f6f', color: '#fff',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
}

const zoomBtnStyle: React.CSSProperties = {
  width: 28, height: 28, padding: 0, border: 'none', cursor: 'pointer',
  background: '#2a3f6f', color: '#fff',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
}

// ─── ASE (Adobe Swatch Exchange) 바이너리 생성 ────────────────────────────────
function buildASE(colors: string[], groupName: string): Blob {
  const buf: number[] = []
  const numBlocks = 2 + colors.length // group start + colors + group end

  const u16 = (v: number) => { buf.push((v >> 8) & 0xff, v & 0xff) }
  const u32 = (v: number) => { buf.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff) }
  const f32 = (v: number) => {
    const dv = new DataView(new ArrayBuffer(4))
    dv.setFloat32(0, v, false)
    buf.push(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3))
  }
  const utf16 = (s: string): number[] => {
    const out: number[] = []
    for (const ch of s) { const c = ch.charCodeAt(0); out.push((c >> 8) & 0xff, c & 0xff) }
    out.push(0, 0) // null terminator
    return out
  }

  // Signature + version
  buf.push(0x41, 0x53, 0x45, 0x46) // "ASEF"
  u16(1); u16(0)                    // version 1.0
  u32(numBlocks)

  // Group start
  const gName = utf16(groupName)
  u16(0xC001)
  u32(2 + gName.length)
  u16(groupName.length + 1) // nameLen including null
  buf.push(...gName)

  // Color entries
  colors.forEach((hex, i) => {
    const name = hex.toUpperCase()
    const nBytes = utf16(name)
    const blockLen = 2 + nBytes.length + 4 + 12 + 2
    u16(0x0001)
    u32(blockLen)
    u16(name.length + 1)
    buf.push(...nBytes)
    buf.push(0x52, 0x47, 0x42, 0x20) // "RGB "
    const r = parseInt(hex.slice(1, 3), 16) / 255
    const g = parseInt(hex.slice(3, 5), 16) / 255
    const b = parseInt(hex.slice(5, 7), 16) / 255
    f32(r); f32(g); f32(b)
    u16(2) // normal
  })

  // Group end
  u16(0xC002); u32(0)

  return new Blob([new Uint8Array(buf)], { type: 'application/octet-stream' })
}

// ─── 미디안 컷 팔레트 추출 ────────────────────────────────────────────────────
function medianCut(data: Uint8ClampedArray, numColors: number): string[] {
  // 최대 ~40000 샘플로 제한 (성능)
  const totalPixels = data.length / 4
  const step = Math.max(1, Math.floor(totalPixels / 40000)) * 4

  const samples: [number, number, number][] = []
  for (let i = 0; i < data.length; i += step) {
    const a = data[i + 3]
    if (a < 128) continue
    samples.push([data[i], data[i + 1], data[i + 2]])
  }
  if (samples.length === 0) return []

  // Median Cut: 큐브를 numColors 개로 분할
  const cubes: [number, number, number][][] = [samples]
  while (cubes.length < numColors) {
    // 범위가 가장 넓은 큐브 선택
    let maxRange = -1, maxIdx = 0
    for (let i = 0; i < cubes.length; i++) {
      const r = channelRange(cubes[i])
      if (r > maxRange) { maxRange = r; maxIdx = i }
    }
    const cube = cubes.splice(maxIdx, 1)[0]
    const [a, b] = splitCube(cube)
    if (a.length === 0 || b.length === 0) { cubes.push(cube); break }
    cubes.push(a, b)
  }

  // 각 큐브의 평균색 → hex
  return cubes.map(cube => {
    const len = cube.length
    const r = Math.round(cube.reduce((s, p) => s + p[0], 0) / len)
    const g = Math.round(cube.reduce((s, p) => s + p[1], 0) / len)
    const b = Math.round(cube.reduce((s, p) => s + p[2], 0) / len)
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')
  })
}

function channelRange(pixels: [number, number, number][]): number {
  let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0
  for (const [r, g, b] of pixels) {
    if (r < minR) minR = r; if (r > maxR) maxR = r
    if (g < minG) minG = g; if (g > maxG) maxG = g
    if (b < minB) minB = b; if (b > maxB) maxB = b
  }
  return Math.max(maxR - minR, maxG - minG, maxB - minB)
}

function splitCube(pixels: [number, number, number][]): [[number, number, number][], [number, number, number][]] {
  let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0
  for (const [r, g, b] of pixels) {
    if (r < minR) minR = r; if (r > maxR) maxR = r
    if (g < minG) minG = g; if (g > maxG) maxG = g
    if (b < minB) minB = b; if (b > maxB) maxB = b
  }
  const ch = (maxR - minR) >= (maxG - minG) && (maxR - minR) >= (maxB - minB) ? 0
           : (maxG - minG) >= (maxB - minB) ? 1 : 2
  const sorted = [...pixels].sort((a, b) => a[ch] - b[ch])
  const mid = Math.floor(sorted.length / 2)
  return [sorted.slice(0, mid) as [number,number,number][], sorted.slice(mid) as [number,number,number][]]
}

// ─── SVG 픽셀 아이콘 ─────────────────────────────────────────────────────────
const S = ({ children, size = 16 }: { children: React.ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
    {children}
  </svg>
)

const IcoSelect = () => <S>
  <path d="M3 2 L3 13 L6 10 L8 14 L10 13 L8 9 L12 9 Z" fill="currentColor" stroke="currentColor" strokeWidth="0.5" strokeLinejoin="round"/>
</S>

const IcoHand = () => <S>
  <path d="M5 8 V4.5 C5 3.8 5.4 3.2 6 3.2 C6.6 3.2 7 3.8 7 4.5 V8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
  <path d="M7 8 V3.8 C7 3.1 7.4 2.5 8 2.5 C8.6 2.5 9 3.1 9 3.8 V8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
  <path d="M9 8 V4.3 C9 3.7 9.4 3.2 10 3.2 C10.6 3.2 11 3.7 11 4.3 V8.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
  <path d="M5 8 L4.2 7.1 C3.7 6.6 2.9 6.6 2.5 7.1 C2.1 7.6 2.1 8.4 2.6 8.9 L5.8 12.7 C6.4 13.4 7.2 13.8 8.1 13.8 H9.7 C11.5 13.8 13 12.3 13 10.5 V7 C13 6.3 12.6 5.8 12 5.8 C11.4 5.8 11 6.3 11 7" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
</S>

const IcoZoomTool = () => <S>
  <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6"/>
  <line x1="7" y1="5" x2="7" y2="9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
  <line x1="5" y1="7" x2="9" y2="7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
  <line x1="10.5" y1="10.5" x2="14" y2="14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
</S>

const IcoPen = () => <S>
  <path d="M3 13 C5 10 7 7 10 5" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round"/>
  <path d="M10 5 L12 3 L13 4 L11 6 Z" fill="currentColor"/>
  <path d="M3 13 L2 14 L4 13.5 Z" fill="currentColor"/>
</S>

const IcoText = () => <S>
  <text x="3" y="13" fontSize="12" fontWeight="700" fontFamily="serif" fill="currentColor">T</text>
</S>

const IcoRect = () => <S>
  <rect x="2" y="4" width="12" height="8" rx="1" fill="none" stroke="currentColor" strokeWidth="2"/>
</S>

const IcoMosaic = () => <S>
  <rect x="2" y="2" width="5" height="5" rx="0.5" fill="currentColor" opacity="0.9"/>
  <rect x="9" y="2" width="5" height="5" rx="0.5" fill="currentColor" opacity="0.5"/>
  <rect x="2" y="9" width="5" height="5" rx="0.5" fill="currentColor" opacity="0.5"/>
  <rect x="9" y="9" width="5" height="5" rx="0.5" fill="currentColor" opacity="0.9"/>
</S>

const IcoCrop = () => <S>
  <path d="M4 2 L4 12 L14 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none"/>
  <path d="M2 4 L12 4 L12 14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" opacity="0.5"/>
</S>

const IcoFill = () => <S>
  <path d="M3 2 L3 10 L7 14 L11 10 L7 2 Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
  <path d="M3 7 L11 7" stroke="currentColor" strokeWidth="1.2"/>
  <circle cx="13.5" cy="12.5" r="1.8" fill="currentColor" opacity="0.9"/>
  <path d="M7 14 Q8.5 15.5 10 14" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round"/>
</S>

const IcoEyedropper = () => <S>
  <path d="M11 2 C12 2 14 4 14 5 L7 12 L4 13 L4 14 L3 14 L3 13 L4 12 L5 9 Z" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinejoin="round"/>
  <circle cx="5.5" cy="11.5" r="1.2" fill="currentColor"/>
  <line x1="9" y1="4" x2="12" y2="7" stroke="currentColor" strokeWidth="1.2" opacity="0.6"/>
</S>

const IcoTrash = () => <S>
  <rect x="3" y="5" width="10" height="9" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5"/>
  <line x1="2" y1="4" x2="14" y2="4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
  <line x1="6" y1="4" x2="6" y2="2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
  <line x1="10" y1="4" x2="10" y2="2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
  <line x1="6" y1="7" x2="6" y2="12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
  <line x1="10" y1="7" x2="10" y2="12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
</S>

const IcoUndo = () => <S>
  <path d="M3 8 C3 5 6 3 9 3 C12 3 14 5 14 8 C14 11 12 13 9 13" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round"/>
  <path d="M3 5 L3 8 L6 8" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
</S>

const IcoRedo = () => <S>
  <path d="M13 8 C13 5 10 3 7 3 C4 3 2 5 2 8 C2 11 4 13 7 13" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round"/>
  <path d="M13 5 L13 8 L10 8" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
</S>

const IcoPageInfo = () => <S>
  <rect x="2" y="2" width="9" height="12" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5"/>
  <line x1="4" y1="6" x2="9" y2="6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
  <line x1="4" y1="9" x2="9" y2="9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
  <circle cx="13" cy="4" r="2.5" fill="currentColor" opacity="0.8"/>
  <line x1="11" y1="6" x2="8" y2="9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
</S>

const IcoClipboard = () => <S>
  <rect x="3" y="4" width="10" height="11" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5"/>
  <rect x="6" y="2" width="4" height="3" rx="1" fill="currentColor"/>
  <line x1="5" y1="8" x2="11" y2="8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
  <line x1="5" y1="11" x2="11" y2="11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
</S>

const IcoShare = () => <S>
  <circle cx="4" cy="8" r="2" fill="currentColor"/>
  <circle cx="12" cy="4" r="2" fill="currentColor"/>
  <circle cx="12" cy="12" r="2" fill="currentColor"/>
  <path d="M5.7 7 L10.3 4.9" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
  <path d="M5.7 9 L10.3 11.1" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
</S>

const IcoPalette = () => <S>
  <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5"/>
  <circle cx="5.5" cy="5.5" r="1.3" fill="currentColor"/>
  <circle cx="10.5" cy="5.5" r="1.3" fill="currentColor" opacity="0.8"/>
  <circle cx="12" cy="9.5" r="1.3" fill="currentColor" opacity="0.7"/>
  <circle cx="5.5" cy="11" r="1.3" fill="currentColor" opacity="0.7"/>
  <circle cx="9" cy="12.5" r="1.3" fill="currentColor" opacity="0.8"/>
</S>

const IcoDownload = () => <S size={12}>
  <line x1="8" y1="2" x2="8" y2="10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
  <path d="M4 7 L8 11 L12 7" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
  <line x1="2" y1="14" x2="14" y2="14" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
</S>

const IcoClose = () => <S>
  <line x1="3" y1="3" x2="13" y2="13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
  <line x1="13" y1="3" x2="3" y2="13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
</S>

const IcoZoomIn = () => <S>
  <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.8"/>
  <line x1="5" y1="7" x2="9" y2="7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
  <line x1="7" y1="5" x2="7" y2="9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
  <line x1="10.5" y1="10.5" x2="14" y2="14" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
</S>

const IcoZoomOut = () => <S>
  <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.8"/>
  <line x1="5" y1="7" x2="9" y2="7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
  <line x1="10.5" y1="10.5" x2="14" y2="14" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
</S>

const IcoArrowDraw = () => <S>
  <line x1="3" y1="13" x2="13" y2="3" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
  <path d="M13 3 L13 8 M13 3 L8 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none"/>
</S>

const IcoEllipse = () => <S>
  <ellipse cx="8" cy="8" rx="6" ry="4" fill="none" stroke="currentColor" strokeWidth="2"/>
</S>

const IcoHighlight = () => <S>
  <rect x="2" y="5" width="12" height="6" rx="1" fill="currentColor" opacity="0.45"/>
  <line x1="2" y1="13" x2="14" y2="13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
</S>

const IcoNumber = () => <S>
  <circle cx="8" cy="8" r="6" fill="currentColor" opacity="0.85"/>
  <text x="8" y="12" textAnchor="middle" fontSize="9" fontWeight="bold" fill="#fff" fontFamily="sans-serif">1</text>
</S>

const IcoRotate90 = () => <S>
  <path d="M5 13 C3 11 3 6 6 4 C9 2 13 4 13 8 C13 11 11 13 8 13" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round"/>
  <path d="M5 10 L5 13 L8 13" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
</S>

const IcoResize = () => <S>
  <rect x="2" y="2" width="9" height="9" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5"/>
  <path d="M11 11 L14 14" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
  <path d="M11 14 L14 14 L14 11" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
</S>

const IcoBrightness = () => <S>
  <circle cx="8" cy="8" r="3" fill="currentColor"/>
  <line x1="8" y1="1" x2="8" y2="3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
  <line x1="8" y1="13" x2="8" y2="15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
  <line x1="1" y1="8" x2="3" y2="8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
  <line x1="13" y1="8" x2="15" y2="8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
  <line x1="3" y1="3" x2="4.5" y2="4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
  <line x1="11.5" y1="11.5" x2="13" y2="13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
  <line x1="13" y1="3" x2="11.5" y2="4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
  <line x1="4.5" y1="11.5" x2="3" y2="13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
</S>

const IcoWatermark = () => <S>
  <rect x="1" y="3" width="14" height="10" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5"/>
  <text x="8" y="11" textAnchor="middle" fontSize="6" fontFamily="sans-serif" fill="currentColor" opacity="0.8">©WM</text>
</S>

const IcoClearAll = () => <S>
  <line x1="3" y1="3" x2="13" y2="13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
  <line x1="13" y1="3" x2="3" y2="13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
  <rect x="1" y="1" width="14" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.5"/>
</S>

const IcoLock = ({ locked }: { locked: boolean }) => <S size={14}>
  {locked ? (
    <>
      <rect x="4" y="7" width="8" height="6" rx="1" fill="currentColor"/>
      <path d="M5 7 V5 C5 3 11 3 11 5 V7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </>
  ) : (
    <>
      <rect x="4" y="7" width="8" height="6" rx="1" fill="currentColor" opacity="0.5"/>
      <path d="M5 7 V5 C5 3 11 3 11 5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="2 1.5"/>
    </>
  )}
</S>

function truncateText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text
  let lo = 0, hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (ctx.measureText(text.slice(0, mid) + '…').width <= maxWidth) lo = mid
    else hi = mid - 1
  }
  return text.slice(0, lo) + '…'
}
