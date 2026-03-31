import { useState, useEffect } from 'react'
import type { HistoryItem, ExtensionSettings } from '../types'
import { DEFAULT_SETTINGS } from '../types'

type Status = 'idle' | 'capturing' | 'error'

export default function Popup() {
  const [status, setStatus] = useState<Status>('idle')
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS)
  const [errorMsg, setErrorMsg] = useState('')

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_HISTORY' }).then(res => {
      setHistory((res?.history ?? []).slice(0, 3))
    })
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }).then(res => {
      if (res?.settings) setSettings(res.settings)
    })
  }, [])

  async function capture(mode: 'CAPTURE_FULL_PAGE' | 'CAPTURE_VIEWPORT' | 'CAPTURE_START_SELECT' | 'CAPTURE_THUMBNAIL' | 'COLOR_PICK_START') {
    setStatus('capturing')
    setErrorMsg('')
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.id) throw new Error('활성 탭을 찾을 수 없습니다.')
      const res = await chrome.runtime.sendMessage({ type: mode })
      if (res?.error) throw new Error(res.error)
      setStatus('idle')
      if (mode !== 'CAPTURE_START_SELECT') window.close()
      else window.close()
    } catch (err) {
      setStatus('error')
      setErrorMsg(String(err))
    }
  }

  return (
    <div style={{ padding: 16 }}>
      {/* 헤더 */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14, gap: 8 }}>
        <span style={{ fontSize: 18 }}>📷</span>
        <span style={{ fontWeight: 700, fontSize: 15, color: '#a8b4ff' }}>uriScreenShot</span>
      </div>

      {/* 캡처 버튼 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <CaptureBtn
          icon="📄"
          label="전체 페이지 캡처"
          sub="스크롤 포함 전체"
          disabled={status === 'capturing'}
          onClick={() => capture('CAPTURE_FULL_PAGE')}
        />
        <CaptureBtn
          icon="🖥"
          label="가시 영역 캡처"
          sub="현재 보이는 화면"
          disabled={status === 'capturing'}
          onClick={() => capture('CAPTURE_VIEWPORT')}
        />
        <CaptureBtn
          icon="✂️"
          label="영역 선택 캡처"
          sub="드래그로 선택"
          disabled={status === 'capturing'}
          onClick={() => { capture('CAPTURE_START_SELECT') }}
        />
        <CaptureBtn
          icon="🪪"
          label="썸네일 캡처"
          sub="페이지 정보 포함 즉시 저장"
          disabled={status === 'capturing'}
          onClick={() => capture('CAPTURE_THUMBNAIL')}
        />
        <button
          disabled={status === 'capturing'}
          onClick={() => capture('COLOR_PICK_START')}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
            background: 'none', border: '1px solid #2a3a5e',
            borderRadius: 6, padding: '4px 0',
            cursor: status === 'capturing' ? 'not-allowed' : 'pointer',
            color: '#8899cc', fontSize: 11, width: '100%',
            opacity: status === 'capturing' ? 0.5 : 1,
          }}
        >
          <span style={{ fontSize: 13 }}>🔍</span> 컬러피커
        </button>
      </div>

      {/* 상태 표시 */}
      {status === 'capturing' && (
        <div style={{ marginTop: 10, color: '#a8b4ff', fontSize: 12 }}>캡처 중...</div>
      )}
      {status === 'error' && (
        <div style={{ marginTop: 10, color: '#ff6b6b', fontSize: 11 }}>{errorMsg}</div>
      )}

      {/* 구분선 */}
      <div style={{ borderTop: '1px solid #333', margin: '14px 0 10px' }} />

      {/* 최근 캡처 히스토리 */}
      {history.length > 0 && (
        <>
          <div style={{ fontSize: 11, color: '#888', marginBottom: 8 }}>최근 캡처</div>
          <div style={{ display: 'flex', gap: 6 }}>
            {history.map(item => (
              <button
                key={item.id}
                title={item.title}
                onClick={() => chrome.tabs.create({ url: item.dataUrl })}
                style={{
                  width: 76, height: 48, padding: 0, border: '1px solid #444',
                  borderRadius: 4, overflow: 'hidden', cursor: 'pointer',
                  background: '#111',
                }}
              >
                <img
                  src={item.dataUrl}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  alt={item.filename}
                />
              </button>
            ))}
          </div>
        </>
      )}

      {/* 설정 링크 */}
      <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-start' }}>
        <button
          onClick={() => chrome.runtime.openOptionsPage()}
          style={{
            background: 'none', border: 'none', color: '#a8b4ff',
            fontSize: 12, cursor: 'pointer', padding: 0,
          }}
        >
          ⚙ 설정
        </button>
      </div>
    </div>
  )
}

function CaptureBtn({
  icon, label, sub, disabled, onClick
}: {
  icon: string; label: string; sub: string; disabled: boolean; onClick: () => void
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        background: disabled ? '#222' : '#16213e',
        border: '1px solid #334',
        borderRadius: 8, padding: '10px 14px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        color: '#e0e0e0', width: '100%', textAlign: 'left',
      }}
    >
      <span style={{ fontSize: 20 }}>{icon}</span>
      <span>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{label}</div>
        <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{sub}</div>
      </span>
    </button>
  )
}
