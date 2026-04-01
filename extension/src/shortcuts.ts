function normalizeKey(key: string): string {
  if (!key) return ''

  const named: Record<string, string> = {
    ' ': 'Space',
    Spacebar: 'Space',
    Esc: 'Escape',
    Del: 'Delete',
    Left: 'ArrowLeft',
    Right: 'ArrowRight',
    Up: 'ArrowUp',
    Down: 'ArrowDown',
  }

  if (named[key]) return named[key]
  if (key.length === 1) return key.toUpperCase()
  return key[0].toUpperCase() + key.slice(1)
}

const RESERVED_SHORTCUT_MESSAGES: Record<string, string> = {
  'Ctrl+L': '주소창 포커스와 충돌할 수 있습니다.',
  'Meta+L': '주소창 포커스와 충돌할 수 있습니다.',
  'Ctrl+R': '페이지 새로고침과 충돌할 수 있습니다.',
  'Meta+R': '페이지 새로고침과 충돌할 수 있습니다.',
  'Ctrl+Shift+R': '강력 새로고침과 충돌할 수 있습니다.',
  'Meta+Shift+R': '강력 새로고침과 충돌할 수 있습니다.',
  'Ctrl+T': '새 탭 열기와 충돌할 수 있습니다.',
  'Meta+T': '새 탭 열기와 충돌할 수 있습니다.',
  'Ctrl+W': '탭 닫기와 충돌할 수 있습니다.',
  'Meta+W': '탭 닫기와 충돌할 수 있습니다.',
  'Ctrl+N': '새 창 열기와 충돌할 수 있습니다.',
  'Meta+N': '새 창 열기와 충돌할 수 있습니다.',
  'Ctrl+Shift+N': '시크릿 창 열기와 충돌할 수 있습니다.',
  'Meta+Shift+N': '시크릿 창 열기와 충돌할 수 있습니다.',
  'Ctrl+P': '인쇄와 충돌할 수 있습니다.',
  'Meta+P': '인쇄와 충돌할 수 있습니다.',
  'Ctrl+S': '페이지 저장과 충돌할 수 있습니다.',
  'Meta+S': '페이지 저장과 충돌할 수 있습니다.',
  'Ctrl+O': '파일 열기와 충돌할 수 있습니다.',
  'Meta+O': '파일 열기와 충돌할 수 있습니다.',
  'Ctrl+J': '다운로드 목록과 충돌할 수 있습니다.',
  'Meta+Alt+L': '다운로드 관련 단축키와 충돌할 수 있습니다.',
  'Ctrl+H': '히스토리 열기와 충돌할 수 있습니다.',
  'Meta+Y': '히스토리 열기와 충돌할 수 있습니다.',
  'Ctrl+F': '페이지 찾기와 충돌할 수 있습니다.',
  'Meta+F': '페이지 찾기와 충돌할 수 있습니다.',
  'Ctrl+D': '북마크 추가와 충돌할 수 있습니다.',
  'Meta+D': '북마크 추가와 충돌할 수 있습니다.',
  'Ctrl+U': '페이지 소스 보기와 충돌할 수 있습니다.',
  'Meta+Alt+U': '페이지 소스 보기와 충돌할 수 있습니다.',
  'Ctrl+Shift+I': '개발자 도구 열기와 충돌할 수 있습니다.',
  'Meta+Alt+I': '개발자 도구 열기와 충돌할 수 있습니다.',
  'Ctrl+Shift+J': '개발자 도구/콘솔과 충돌할 수 있습니다.',
  'Meta+Alt+J': '개발자 도구/콘솔과 충돌할 수 있습니다.',
  'Ctrl+Tab': '탭 전환과 충돌할 수 있습니다.',
  'Ctrl+Shift+Tab': '탭 전환과 충돌할 수 있습니다.',
  'Meta+Shift+Tab': '탭 전환과 충돌할 수 있습니다.',
  'Alt+Tab': '운영체제 앱 전환과 충돌합니다.',
  'Meta+Tab': '운영체제/브라우저 전환과 충돌할 수 있습니다.',
  'Meta+Space': '운영체제 검색과 충돌할 수 있습니다.',
  'Ctrl+Space': '입력기 전환과 충돌할 수 있습니다.',
  'Alt+Shift': '입력 언어 전환과 충돌할 수 있습니다.',
}

export function normalizeShortcut(shortcut: string): string {
  const parts = shortcut
    .split('+')
    .map(part => part.trim())
    .filter(Boolean)

  if (parts.length === 0) return ''

  const modifiers = new Set<string>()
  let key = ''

  for (const part of parts) {
    const lower = part.toLowerCase()
    if (lower === 'ctrl' || lower === 'control') modifiers.add('Ctrl')
    else if (lower === 'meta' || lower === 'cmd' || lower === 'command') modifiers.add('Meta')
    else if (lower === 'alt' || lower === 'option') modifiers.add('Alt')
    else if (lower === 'shift') modifiers.add('Shift')
    else key = normalizeKey(part)
  }

  const ordered = ['Ctrl', 'Meta', 'Alt', 'Shift'].filter(mod => modifiers.has(mod))
  return [...ordered, key].filter(Boolean).join('+')
}

export function shortcutHasPrimaryModifier(shortcut: string): boolean {
  const normalized = normalizeShortcut(shortcut)
  if (!normalized) return false
  const parts = normalized.split('+')
  const modifiers = new Set(parts.slice(0, -1))
  return modifiers.has('Ctrl') || modifiers.has('Meta') || modifiers.has('Alt')
}

export function sanitizeShortcut(shortcut: string, fallback: string): string {
  const normalized = normalizeShortcut(shortcut)
  if (!normalized || !shortcutHasPrimaryModifier(normalized) || isReservedShortcut(normalized)) {
    return normalizeShortcut(fallback)
  }
  return normalized
}

export function isReservedShortcut(shortcut: string): boolean {
  const normalized = normalizeShortcut(shortcut)
  return Boolean(RESERVED_SHORTCUT_MESSAGES[normalized])
}

export function getShortcutConflictMessage(shortcut: string): string | null {
  const normalized = normalizeShortcut(shortcut)
  return RESERVED_SHORTCUT_MESSAGES[normalized] ?? null
}

export function matchesShortcut(event: KeyboardEvent, shortcut: string): boolean {
  const normalized = normalizeShortcut(shortcut)
  if (!normalized || !shortcutHasPrimaryModifier(normalized)) return false

  const parts = normalized.split('+')
  const key = parts[parts.length - 1]
  const modifiers = new Set(parts.slice(0, -1))

  return (
    event.ctrlKey === modifiers.has('Ctrl') &&
    event.metaKey === modifiers.has('Meta') &&
    event.altKey === modifiers.has('Alt') &&
    event.shiftKey === modifiers.has('Shift') &&
    normalizeKey(event.key) === key
  )
}

export function isTypingTarget(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null
  if (!node) return false
  const tag = node.tagName
  return node.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}
