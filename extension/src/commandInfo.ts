export const COMMANDS = {
  captureFullPage: 'capture-full-page',
  captureViewport: 'capture-viewport',
  captureRegion: 'capture-region',
  captureThumbnail: 'capture-thumbnail',
  colorPicker: 'color-picker',
  openRecorder: 'open-recorder',
  recorderStart: 'recorder-start',
  recorderStop: 'recorder-stop',
  recorderSave: 'recorder-save',
  recorderReset: 'recorder-reset',
} as const

export type CommandName = typeof COMMANDS[keyof typeof COMMANDS]

export const COMMAND_DESCRIPTIONS: Record<CommandName, string> = {
  [COMMANDS.captureFullPage]: '전체 페이지 캡처',
  [COMMANDS.captureViewport]: '가시 영역 캡처',
  [COMMANDS.captureRegion]: '영역 선택 캡처',
  [COMMANDS.captureThumbnail]: '썸네일 캡처',
  [COMMANDS.colorPicker]: '컬러피커 시작',
  [COMMANDS.openRecorder]: '현재 탭 녹화 열기',
  [COMMANDS.recorderStart]: '녹화 시작',
  [COMMANDS.recorderStop]: '녹화 종료',
  [COMMANDS.recorderSave]: '녹화 저장',
  [COMMANDS.recorderReset]: '녹화 초기화',
}

export async function loadCommandShortcuts(): Promise<Record<string, string>> {
  const commands = await chrome.commands.getAll()
  return Object.fromEntries(commands.map(command => [command.name ?? '', command.shortcut ?? '']))
}

export function shortcutLabel(shortcuts: Record<string, string>, command: CommandName): string {
  return shortcuts[command] || '미지정'
}
