import { sanitizeShortcut } from './shortcuts'

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

export interface ShortcutSettings {
  captureFullPage: string
  captureViewport: string
  captureRegion: string
  captureThumbnail: string
  colorPicker: string
  openRecorder: string
  recorderStart: string
  recorderStop: string
  recorderSave: string
  recorderReset: string
}

export interface ExtensionSettings {
  defaultFormat: ImageFormat
  jpegQuality: number
  autoSave: boolean
  filenameTemplate: string
  thumbSaveDir: string
  shortcuts: ShortcutSettings
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  defaultFormat: 'png',
  jpegQuality: 0.9,
  autoSave: false,
  filenameTemplate: '{datetime}',
  thumbSaveDir: 'site_thumb',
  shortcuts: {
    captureFullPage: 'Ctrl+Alt+Shift+1',
    captureViewport: 'Ctrl+Alt+Shift+2',
    captureRegion: 'Ctrl+Alt+Shift+3',
    captureThumbnail: 'Ctrl+Alt+Shift+4',
    colorPicker: 'Ctrl+Alt+Shift+5',
    openRecorder: 'Ctrl+Alt+Shift+R',
    recorderStart: 'Ctrl+Alt+Shift+Enter',
    recorderStop: 'Ctrl+Alt+Shift+.',
    recorderSave: 'Ctrl+Alt+Shift+S',
    recorderReset: 'Ctrl+Alt+Shift+Backspace',
  },
}

export function mergeSettings(settings?: Partial<ExtensionSettings>): ExtensionSettings {
  const mergedShortcuts = {
    ...DEFAULT_SETTINGS.shortcuts,
    ...(settings?.shortcuts ?? {}),
  }

  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    shortcuts: {
      captureFullPage: sanitizeShortcut(mergedShortcuts.captureFullPage, DEFAULT_SETTINGS.shortcuts.captureFullPage),
      captureViewport: sanitizeShortcut(mergedShortcuts.captureViewport, DEFAULT_SETTINGS.shortcuts.captureViewport),
      captureRegion: sanitizeShortcut(mergedShortcuts.captureRegion, DEFAULT_SETTINGS.shortcuts.captureRegion),
      captureThumbnail: sanitizeShortcut(mergedShortcuts.captureThumbnail, DEFAULT_SETTINGS.shortcuts.captureThumbnail),
      colorPicker: sanitizeShortcut(mergedShortcuts.colorPicker, DEFAULT_SETTINGS.shortcuts.colorPicker),
      openRecorder: sanitizeShortcut(mergedShortcuts.openRecorder, DEFAULT_SETTINGS.shortcuts.openRecorder),
      recorderStart: sanitizeShortcut(mergedShortcuts.recorderStart, DEFAULT_SETTINGS.shortcuts.recorderStart),
      recorderStop: sanitizeShortcut(mergedShortcuts.recorderStop, DEFAULT_SETTINGS.shortcuts.recorderStop),
      recorderSave: sanitizeShortcut(mergedShortcuts.recorderSave, DEFAULT_SETTINGS.shortcuts.recorderSave),
      recorderReset: sanitizeShortcut(mergedShortcuts.recorderReset, DEFAULT_SETTINGS.shortcuts.recorderReset),
    },
  }
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
