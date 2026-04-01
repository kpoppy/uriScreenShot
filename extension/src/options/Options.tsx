import { useState, useEffect } from 'react'
import type { ExtensionSettings, ImageFormat } from '../types'
import { DEFAULT_SETTINGS, mergeSettings } from '../types'
import { COMMAND_DESCRIPTIONS, COMMANDS, loadCommandShortcuts, shortcutLabel, type CommandName } from '../commandInfo'

export default function Options() {
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS)
  const [saved, setSaved] = useState(false)
  const [commandShortcuts, setCommandShortcuts] = useState<Record<string, string>>({})

  useEffect(() => {
    const reloadCommandShortcuts = () => {
      loadCommandShortcuts().then(setCommandShortcuts).catch(() => {})
    }

    chrome.storage.sync.get('settings').then(result => {
      if (result.settings) setSettings(mergeSettings(result.settings))
    })
    reloadCommandShortcuts()

    window.addEventListener('focus', reloadCommandShortcuts)
    return () => window.removeEventListener('focus', reloadCommandShortcuts)
  }, [])

  function update<K extends keyof ExtensionSettings>(key: K, value: ExtensionSettings[K]) {
    setSettings(prev => ({ ...prev, [key]: value }))
    setSaved(false)
  }

  async function openShortcutManager() {
    await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })
  }

  async function save() {
    await chrome.storage.sync.set({ settings })
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div>
      <h1 style={{ fontSize: 20, marginBottom: 24, color: '#a8b4ff' }}>📷 uriScreenShot 설정</h1>

      <Section title="저장 설정">
        <Row label="기본 형식">
          {(['png', 'jpeg', 'pdf'] as ImageFormat[]).map(f => (
            <label key={f} style={{ marginRight: 12, cursor: 'pointer' }}>
              <input type="radio" name="format" value={f}
                checked={settings.defaultFormat === f}
                onChange={() => update('defaultFormat', f)} />
              {' '}{f.toUpperCase()}
            </label>
          ))}
        </Row>
        <Row label="JPEG 품질">
          <input type="range" min={10} max={100} step={5}
            value={Math.round(settings.jpegQuality * 100)}
            onChange={e => update('jpegQuality', Number(e.target.value) / 100)} />
          <span style={{ marginLeft: 8, fontSize: 12 }}>{Math.round(settings.jpegQuality * 100)}%</span>
        </Row>
        <Row label="파일명 형식">
          <input
            type="text" value={settings.filenameTemplate}
            onChange={e => update('filenameTemplate', e.target.value)}
            style={inputStyle}
          />
          <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
            변수: {'{date}'}, {'{time}'}, {'{datetime}'}
          </div>
        </Row>
      </Section>

      <Section title="썸네일 캡처">
        <Row label="저장 폴더">
          <input
            type="text" value={settings.thumbSaveDir}
            onChange={e => update('thumbSaveDir', e.target.value)}
            style={inputStyle}
            placeholder="site_thumb"
          />
          <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
            다운로드 폴더 기준 상대경로 (예: <code>site_thumb</code> → Downloads/site_thumb/)
          </div>
        </Row>
      </Section>

      <Section title="동작">
        <Row label="자동 저장">
          <Toggle
            value={settings.autoSave}
            onChange={v => update('autoSave', v)}
            label="편집기 없이 바로 다운로드"
          />
        </Row>
      </Section>

      <Section title="단축키">
        <div style={noteStyle}>
          전역 단축키는 Chrome 공식 <code>chrome.commands</code>로 동작합니다. 변경은 Chrome의 확장 단축키 설정 화면에서 하며, 브라우저가 포커스된 상태에서 사용할 수 있습니다.
        </div>
        <div style={{ marginBottom: 14 }}>
          <button
            onClick={openShortcutManager}
            style={secondaryBtnStyle}
          >
            Chrome 단축키 설정 열기
          </button>
        </div>

        <CommandsTable commandShortcuts={commandShortcuts} />
      </Section>

      <button
        onClick={save}
        style={{
          marginTop: 24, padding: '10px 28px', background: '#4A90E2',
          border: 'none', borderRadius: 6, color: '#fff', fontSize: 14,
          cursor: 'pointer', fontWeight: 600,
        }}
      >
        {saved ? '✓ 저장됨' : '저장'}
      </button>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 14, color: '#a8b4ff', marginBottom: 12, borderBottom: '1px solid #334', paddingBottom: 6 }}>
        {title}
      </h2>
      {children}
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 12 }}>
      <span style={{ width: 120, fontSize: 13, color: '#aaa', flexShrink: 0, paddingTop: 2 }}>{label}</span>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  )
}

function Toggle({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
      <input type="checkbox" checked={value} onChange={e => onChange(e.target.checked)} />
      <span style={{ fontSize: 13 }}>{label}</span>
    </label>
  )
}

function CommandsTable({ commandShortcuts }: { commandShortcuts: Record<string, string> }) {
  const orderedCommands: CommandName[] = [
    COMMANDS.captureFullPage,
    COMMANDS.captureViewport,
    COMMANDS.captureRegion,
    COMMANDS.captureThumbnail,
    COMMANDS.colorPicker,
    COMMANDS.openRecorder,
    COMMANDS.recorderStart,
    COMMANDS.recorderStop,
    COMMANDS.recorderSave,
    COMMANDS.recorderReset,
  ]

  return (
    <div style={commandsListStyle}>
      {orderedCommands.map(command => (
        <div key={command} style={commandRowStyle}>
          <span style={{ fontSize: 12, color: '#dbe7ff' }}>{COMMAND_DESCRIPTIONS[command]}</span>
          <code style={commandCodeStyle}>{shortcutLabel(commandShortcuts, command)}</code>
        </div>
      ))}
      <div style={{ marginTop: 8, fontSize: 11, color: '#8898b8', lineHeight: 1.5 }}>
        Chrome 제한으로 기본 추천 단축키는 최대 4개만 제공됩니다. 현재는 `녹화 열기`, `녹화 시작`, `녹화 종료`, `녹화 저장`에 우선 배정되어 있고, 나머지는 `chrome://extensions/shortcuts`에서 직접 추가해 주세요.
      </div>
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  background: '#0f0f23', border: '1px solid #444', color: '#e0e0e0',
  padding: '4px 8px', borderRadius: 4, fontSize: 13, width: '100%',
}

const noteStyle: React.CSSProperties = {
  marginBottom: 12,
  fontSize: 11,
  color: '#888',
  lineHeight: 1.5,
}

const secondaryBtnStyle: React.CSSProperties = {
  padding: '7px 12px',
  background: '#2a3f6f',
  border: '1px solid #3d5a97',
  borderRadius: 6,
  color: '#dce7ff',
  fontSize: 12,
  cursor: 'pointer',
  fontWeight: 600,
}

const commandsListStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

const commandRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 16,
  padding: '8px 10px',
  borderRadius: 6,
  background: '#11172c',
  border: '1px solid #243457',
}

const commandCodeStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#a8c5ff',
  fontFamily: 'monospace',
}
