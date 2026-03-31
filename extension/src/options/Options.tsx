import { useState, useEffect } from 'react'
import type { ExtensionSettings, ImageFormat } from '../types'
import { DEFAULT_SETTINGS } from '../types'

export default function Options() {
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    chrome.storage.sync.get('settings').then(result => {
      if (result.settings) setSettings({ ...DEFAULT_SETTINGS, ...result.settings })
    })
  }, [])

  function update<K extends keyof ExtensionSettings>(key: K, value: ExtensionSettings[K]) {
    setSettings(prev => ({ ...prev, [key]: value }))
    setSaved(false)
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

const inputStyle: React.CSSProperties = {
  background: '#0f0f23', border: '1px solid #444', color: '#e0e0e0',
  padding: '4px 8px', borderRadius: 4, fontSize: 13, width: '100%',
}
