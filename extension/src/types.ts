// 공통 타입 정의

export type CaptureMode = 'full_page' | 'viewport' | 'region'
export type ImageFormat = 'png' | 'jpeg' | 'pdf'
export type EditorTool = 'pen' | 'text' | 'rect' | 'mosaic' | 'crop' | 'select' | 'eyedropper' | 'fill' | 'arrow' | 'ellipse' | 'highlight' | 'number'

export interface ExtMessage {
  type: string
  [key: string]: unknown
}

export interface CaptureViewportRawRequest {
  type: 'CAPTURE_VIEWPORT_RAW'
}

export interface CaptureFullPageRequest {
  type: 'CAPTURE_FULL_PAGE'
}

export interface CaptureViewportRequest {
  type: 'CAPTURE_VIEWPORT'
}

export interface CaptureStartSelectRequest {
  type: 'CAPTURE_START_SELECT'
}

export interface CaptureSelectedRequest {
  type: 'CAPTURE_SELECTED'
  rect: { x: number; y: number; width: number; height: number }
}

export interface OpenEditorRequest {
  type: 'OPEN_EDITOR'
  imageData: string
  width: number
  height: number
}

export interface GetHistoryRequest {
  type: 'GET_HISTORY'
}

export interface CaptureResult {
  dataUrl: string
  width: number
  height: number
}

export interface HistoryItem {
  id: string
  timestamp: number
  filename: string
  dataUrl: string
  width: number
  height: number
  url: string
  title: string
}

export interface ExtensionSettings {
  defaultFormat: ImageFormat
  jpegQuality: number
  autoSave: boolean
  filenameTemplate: string
  thumbSaveDir: string
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  defaultFormat: 'png',
  jpegQuality: 0.9,
  autoSave: false,
  filenameTemplate: '{datetime}',
  thumbSaveDir: 'site_thumb',
}

export function generateFilename(template: string): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return template
    .replace('{date}', date)
    .replace('{time}', time)
    .replace('{datetime}', `${date}_${time}`)
}
