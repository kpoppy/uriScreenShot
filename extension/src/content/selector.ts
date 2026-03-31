// 영역 선택 오버레이

interface SelectionRect {
  x: number; y: number; width: number; height: number
}

class RegionSelector {
  private overlay: HTMLDivElement | null = null
  private selection: HTMLDivElement | null = null
  private tooltip: HTMLDivElement | null = null
  private startX = 0
  private startY = 0
  private isDragging = false

  start(): Promise<SelectionRect> {
    return new Promise((resolve, reject) => {
      this.createOverlay()

      const handleMouseDown = (e: MouseEvent) => {
        this.isDragging = true
        this.startX = e.clientX
        this.startY = e.clientY
        this.selection!.style.display = 'block'
        updateSelection(e.clientX, e.clientY, e.clientX, e.clientY)
      }

      const handleMouseMove = (e: MouseEvent) => {
        if (!this.isDragging) {
          updateTooltip(e.clientX, e.clientY)
          return
        }
        updateSelection(this.startX, this.startY, e.clientX, e.clientY)
      }

      const handleMouseUp = (e: MouseEvent) => {
        if (!this.isDragging) return
        this.isDragging = false
        const rect = getRect(this.startX, this.startY, e.clientX, e.clientY)
        cleanup()
        if (rect.width < 5 || rect.height < 5) {
          reject(new Error('Selection too small'))
          return
        }
        // 스크롤 오프셋 보정
        resolve({
          x: rect.x + window.scrollX,
          y: rect.y + window.scrollY,
          width: rect.width,
          height: rect.height,
        })
      }

      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          cleanup()
          reject(new Error('Cancelled'))
        }
      }

      const updateTooltip = (cx: number, cy: number) => {
        if (!this.tooltip) return
        this.tooltip.style.left = `${cx + 12}px`
        this.tooltip.style.top = `${cy + 12}px`
        this.tooltip.textContent = `${cx}, ${cy}`
      }

      const updateSelection = (x1: number, y1: number, x2: number, y2: number) => {
        const r = getRect(x1, y1, x2, y2)
        Object.assign(this.selection!.style, {
          left: `${r.x}px`,
          top: `${r.y}px`,
          width: `${r.width}px`,
          height: `${r.height}px`,
        })
        if (this.tooltip) {
          this.tooltip.textContent = `${r.width} × ${r.height}`
          this.tooltip.style.left = `${x2 + 12}px`
          this.tooltip.style.top = `${y2 + 12}px`
        }
      }

      const cleanup = () => {
        this.overlay?.remove()
        this.overlay = null
        this.selection = null
        this.tooltip = null
        document.removeEventListener('mousedown', handleMouseDown)
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
        document.removeEventListener('keydown', handleKeyDown)
        document.body.style.cursor = ''
      }

      document.addEventListener('mousedown', handleMouseDown)
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
      document.addEventListener('keydown', handleKeyDown)
    })
  }

  private createOverlay() {
    this.overlay = document.createElement('div')
    this.overlay.id = 'uri-screenshot-overlay'
    document.body.appendChild(this.overlay)

    this.selection = document.createElement('div')
    this.selection.id = 'uri-screenshot-selection'
    this.selection.style.display = 'none'
    this.overlay.appendChild(this.selection)

    this.tooltip = document.createElement('div')
    this.tooltip.id = 'uri-screenshot-tooltip'
    this.tooltip.textContent = '드래그하여 영역 선택'
    this.overlay.appendChild(this.tooltip)

    document.body.style.cursor = 'crosshair'
  }
}

function getRect(x1: number, y1: number, x2: number, y2: number) {
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  }
}

// ─── 메시지 수신 ─────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'START_SELECT_MODE') {
    const selector = new RegionSelector()
    selector.start()
      .then(rect => {
        chrome.runtime.sendMessage({ type: 'CAPTURE_SELECTED', rect })
        sendResponse({ ok: true })
      })
      .catch(err => sendResponse({ error: String(err) }))
    return true
  }
  return false
})

console.log('[uriScreenShot] Selector ready')
