import { useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_SETTINGS, type ExtensionSettings, generateFilename, mergeSettings } from '../types'
import { COMMANDS, loadCommandShortcuts, shortcutLabel } from '../commandInfo'

type RecorderStatus = 'idle' | 'requesting' | 'recording' | 'stopped' | 'error'

const MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=h264,opus',
  'video/webm',
]

export default function Recorder() {
  const [status, setStatus] = useState<RecorderStatus>('idle')
  const [captureAudio, setCaptureAudio] = useState(true)
  const [errorMsg, setErrorMsg] = useState('')
  const [videoUrl, setVideoUrl] = useState('')
  const [mimeType, setMimeType] = useState('video/webm')
  const [elapsedMs, setElapsedMs] = useState(0)
  const [recordedSize, setRecordedSize] = useState(0)
  const [sourceLabel, setSourceLabel] = useState('현재 탭')
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS)
  const [commandShortcuts, setCommandShortcuts] = useState<Record<string, string>>({})

  const previewRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const startedAtRef = useRef<number>(0)
  const timerRef = useRef<number | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)

  const search = new URLSearchParams(window.location.search)
  const targetTabId = Number(search.get('tabId') || 0)
  const targetTitle = search.get('title') || ''

  const canStart = status === 'idle' || status === 'stopped' || status === 'error'
  const hasRecording = Boolean(videoUrl)

  const prettyElapsed = useMemo(() => {
    const totalSec = Math.floor(elapsedMs / 1000)
    const min = String(Math.floor(totalSec / 60)).padStart(2, '0')
    const sec = String(totalSec % 60).padStart(2, '0')
    return `${min}:${sec}`
  }, [elapsedMs])

  const prettySize = useMemo(() => {
    if (!recordedSize) return '0 MB'
    const mb = recordedSize / 1024 / 1024
    return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`
  }, [recordedSize])

  useEffect(() => {
    return () => {
      stopTimer()
      stopStream()
      audioContextRef.current?.close().catch(() => {})
      audioContextRef.current = null
      if (videoUrl) URL.revokeObjectURL(videoUrl)
    }
  }, [videoUrl])

  useEffect(() => {
    if (targetTitle) setSourceLabel(targetTitle)
  }, [targetTitle])

  useEffect(() => {
    chrome.storage.sync.get('settings').then(result => {
      if (result.settings) setSettings(mergeSettings(result.settings))
    })
    loadCommandShortcuts().then(setCommandShortcuts).catch(() => {})
  }, [])

  useEffect(() => {
    chrome.runtime.sendMessage({
      type: 'REGISTER_RECORDER_WINDOW',
      targetTabId,
    }).then((res) => {
      const pending = res?.pendingCommand as string | undefined
      if (pending === 'start' && canStart) {
        void startRecording()
      }
    }).catch(() => {})

    return () => {
      chrome.runtime.sendMessage({ type: 'RECORDER_STATUS', status: 'closed' }).catch(() => {})
    }
  }, [])

  useEffect(() => {
    const onMessage = (message: unknown) => {
      const msg = message as { type?: string; command?: string }
      if (msg.type !== 'RECORDER_COMMAND') return

      if (msg.command === 'start' && canStart) {
        void startRecording()
        chrome.runtime.sendMessage({ type: 'RECORDER_COMMAND_CONSUMED' }).catch(() => {})
      } else if (msg.command === 'stop' && status === 'recording') {
        stopRecording()
        chrome.runtime.sendMessage({ type: 'RECORDER_COMMAND_CONSUMED' }).catch(() => {})
      } else if (msg.command === 'save' && hasRecording) {
        downloadRecording()
        chrome.runtime.sendMessage({ type: 'RECORDER_COMMAND_CONSUMED' }).catch(() => {})
      } else if (msg.command === 'reset' && status !== 'recording' && status !== 'requesting') {
        resetRecording()
        chrome.runtime.sendMessage({ type: 'RECORDER_COMMAND_CONSUMED' }).catch(() => {})
      }
    }

    chrome.runtime.onMessage.addListener(onMessage)
    return () => chrome.runtime.onMessage.removeListener(onMessage)
  }, [canStart, hasRecording, status, videoUrl])

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (status !== 'recording') return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [status])

  function stopTimer() {
    if (timerRef.current != null) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
  }

  function stopStream() {
    streamRef.current?.getTracks().forEach(track => track.stop())
    streamRef.current = null
    if (previewRef.current) previewRef.current.srcObject = null
    audioContextRef.current?.close().catch(() => {})
    audioContextRef.current = null
  }

  function resetRecording() {
    stopTimer()
    stopStream()
    recorderRef.current = null
    chunksRef.current = []
    setElapsedMs(0)
    setRecordedSize(0)
    if (videoUrl) {
      URL.revokeObjectURL(videoUrl)
      setVideoUrl('')
    }
  }

  async function startRecording() {
    resetRecording()
    setErrorMsg('')
    setStatus('requesting')

    try {
      const preferredMime = MIME_CANDIDATES.find(candidate => MediaRecorder.isTypeSupported(candidate)) ?? 'video/webm'
      setMimeType(preferredMime)
      if (!targetTabId) throw new Error('녹화 대상 탭 정보가 없습니다. 팝업에서 다시 시작해 주세요.')

      const res = await chrome.runtime.sendMessage({
        type: 'GET_TAB_RECORDING_STREAM_ID',
        targetTabId,
      })
      if (res?.error) throw new Error(String(res.error))
      if (!res?.streamId) throw new Error('탭 녹화 스트림을 시작하지 못했습니다.')

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: captureAudio
          ? {
              mandatory: {
                chromeMediaSource: 'tab',
                chromeMediaSourceId: res.streamId,
              },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any
          : false,
        video: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: res.streamId,
            maxFrameRate: 30,
          },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      })
      streamRef.current = stream

      if (captureAudio && stream.getAudioTracks().length > 0) {
        const audioContext = new AudioContext()
        const source = audioContext.createMediaStreamSource(stream)
        source.connect(audioContext.destination)
        audioContextRef.current = audioContext
      }

      if (previewRef.current) {
        previewRef.current.srcObject = stream
        previewRef.current.muted = true
        await previewRef.current.play().catch(() => {})
      }

      const recorder = new MediaRecorder(stream, { mimeType: preferredMime })
      recorderRef.current = recorder
      chunksRef.current = []
      startedAtRef.current = Date.now()
      setElapsedMs(0)
      setRecordedSize(0)

      recorder.ondataavailable = (event) => {
        if (!event.data || event.data.size === 0) return
        chunksRef.current.push(event.data)
        setRecordedSize(chunksRef.current.reduce((sum, chunk) => sum + chunk.size, 0))
      }

      recorder.onerror = () => {
        setStatus('error')
        setErrorMsg('REC-05: 녹화 중 오류가 발생했습니다. 다시 시도해 주세요.')
        stopTimer()
        stopStream()
      }

      recorder.onstop = () => {
        stopTimer()
        stopStream()

        if (chunksRef.current.length === 0) {
          setStatus('idle')
          setErrorMsg('REC-04: 저장할 녹화 데이터가 없습니다. 녹화 시작 후 다시 시도해 주세요.')
          return
        }

        const blob = new Blob(chunksRef.current, { type: preferredMime })
        const nextUrl = URL.createObjectURL(blob)
        setVideoUrl(prev => {
          if (prev) URL.revokeObjectURL(prev)
          return nextUrl
        })
        setRecordedSize(blob.size)
        setStatus('stopped')
      }

      stream.getVideoTracks().forEach(track => {
        track.onended = () => {
          if (recorder.state !== 'inactive') recorder.stop()
        }
      })

      recorder.start(1000)
      setStatus('recording')
      timerRef.current = window.setInterval(() => {
        setElapsedMs(Date.now() - startedAtRef.current)
      }, 250)
    } catch (err) {
      stopTimer()
      stopStream()
      setStatus('error')
      setErrorMsg(formatRecorderError(err))
    }
  }

  function stopRecording() {
    const recorder = recorderRef.current
    if (!recorder || recorder.state === 'inactive') return
    recorder.stop()
  }

  function downloadRecording() {
    if (!videoUrl) return
    const anchor = document.createElement('a')
    anchor.href = videoUrl
    anchor.download = `${generateFilename('{datetime}')}.webm`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  }

  async function openShortcutManager() {
    await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 18, boxSizing: 'border-box', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <div style={logoStyle}>REC</div>
        <div>
          <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.03em' }}>uriScreenShot Recorder</div>
          <div style={{ fontSize: 12, color: '#9cb0cf' }}>탭, 창, 화면을 직접 선택해서 녹화하고 바로 저장합니다.</div>
        </div>
      </div>

      <div style={heroStyle}>
        <div style={leftColumnStyle}>
          <div style={sectionTitleStyle}>녹화 흐름</div>
          <div style={{ display: 'grid', gap: 6, color: '#d7e2f5', fontSize: 12 }}>
            <div>1. 이 창은 컨트롤 패널이고, 실제 녹화 대상은 확장을 눌렀던 원래 탭입니다.</div>
            <div>2. `녹화 시작`을 누르면 그 탭의 화면과 오디오를 바로 기록합니다.</div>
            <div>3. 녹화가 끝나면 `녹화 종료` 후 `WebM 저장`으로 내려받습니다.</div>
          </div>

          <div style={leftInfoGridStyle}>
            <div style={sourceCardStyle}>
              <div style={{ fontSize: 11, color: '#8ea2c2', marginBottom: 6 }}>녹화 대상 탭</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#f3f7ff', wordBreak: 'break-word', lineHeight: 1.35 }}>{sourceLabel}</div>
            </div>

            <div style={sourceCardStyle}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
                <div style={{ fontSize: 11, color: '#8ea2c2' }}>녹화 단축키</div>
                <button
                  onClick={openShortcutManager}
                  style={miniActionBtnStyle}
                >
                  지정
                </button>
              </div>
              <div style={{ display: 'grid', gap: 5, fontSize: 11, color: '#dce6f7' }}>
                <div>시작: <code>{shortcutLabel(commandShortcuts, COMMANDS.recorderStart)}</code></div>
                <div>종료: <code>{shortcutLabel(commandShortcuts, COMMANDS.recorderStop)}</code></div>
                <div>저장: <code>{shortcutLabel(commandShortcuts, COMMANDS.recorderSave)}</code></div>
                <div>초기화: <code>{shortcutLabel(commandShortcuts, COMMANDS.recorderReset)}</code></div>
              </div>
            </div>
          </div>

          <label style={toggleRowStyle}>
            <input
              type="checkbox"
              checked={captureAudio}
              onChange={e => setCaptureAudio(e.target.checked)}
              disabled={status === 'recording' || status === 'requesting'}
            />
            <span>가능하면 시스템/탭 오디오도 함께 요청</span>
          </label>

          <div style={actionGridStyle}>
            <button onClick={startRecording} disabled={!canStart} style={{ ...actionBtnStyle, background: '#e84f5c' }}>
              {status === 'requesting' ? '권한 요청 중...' : `녹화 시작 · ${shortcutLabel(commandShortcuts, COMMANDS.recorderStart)}`}
            </button>
            <button onClick={stopRecording} disabled={status !== 'recording'} style={{ ...actionBtnStyle, background: '#2c3d5f' }}>
              녹화 종료 · {shortcutLabel(commandShortcuts, COMMANDS.recorderStop)}
            </button>
            <button onClick={downloadRecording} disabled={!hasRecording} style={{ ...actionBtnStyle, background: '#237a57' }}>
              저장 · {shortcutLabel(commandShortcuts, COMMANDS.recorderSave)}
            </button>
            <button onClick={resetRecording} disabled={status === 'recording' || status === 'requesting'} style={{ ...actionBtnStyle, background: '#3a4258' }}>
              초기화 · {shortcutLabel(commandShortcuts, COMMANDS.recorderReset)}
            </button>
          </div>

          {errorMsg && (
            <div style={errorStyle}>
              {errorMsg}
            </div>
          )}
        </div>

        <div style={previewPanelStyle}>
          <div style={previewHeaderStyle}>
            <span>미리보기</span>
            <span style={{ color: '#8fa2be', fontSize: 12 }}>
              {status === 'recording' ? '실시간 입력' : hasRecording ? '저장 전 확인' : '대기 중'}
            </span>
          </div>

          {hasRecording ? (
            <video
              src={videoUrl}
              controls
              style={videoStyle}
            />
          ) : (
            <video
              ref={previewRef}
              autoPlay
              playsInline
              muted
              style={videoStyle}
            />
          )}

          <div style={{ fontSize: 11, color: '#92a7c9', lineHeight: 1.45 }}>
            컨트롤 창이 열려 있어도 녹화되는 건 원래 웹페이지 탭입니다.
          </div>

          <div style={statGridStyle}>
            <StatCard label="상태" value={statusLabel(status)} accent={status === 'recording' ? '#ff7f8a' : '#8fb6ff'} />
            <StatCard label="경과 시간" value={prettyElapsed} accent="#9fe6b0" />
            <StatCard label="형식" value={mimeType.replace('video/', '').toUpperCase()} accent="#ffd387" />
            <StatCard label="파일 크기" value={prettySize} accent="#c9a8ff" />
          </div>
        </div>
      </div>
    </div>
  )
}

function formatRecorderError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const lower = raw.toLowerCase()

  if (lower.includes('activeTab permission') || lower.includes('chrome pages cannot be captured')) {
    return 'REC-01: 이 페이지는 브라우저 정책상 녹화할 수 없습니다. 일반 웹페이지에서 다시 시도해 주세요.'
  }
  if (lower.includes('notallowed') || lower.includes('permission denied')) {
    return 'REC-02: 브라우저가 탭 녹화를 허용하지 않았습니다. 페이지를 다시 선택하거나 확장을 다시 실행해 주세요.'
  }
  if (lower.includes('could not start video source') || lower.includes('error starting tab capture')) {
    return 'REC-03: 탭 캡처 시작에 실패했습니다. 탭을 새로고침한 뒤 다시 시도해 주세요.'
  }
  if (lower.includes('stream') && lower.includes('not')) {
    return 'REC-06: 녹화 스트림을 준비하지 못했습니다. 녹화창을 닫고 다시 열어 주세요.'
  }
  return `REC-99: ${raw}`
}

function statusLabel(status: RecorderStatus): string {
  switch (status) {
    case 'idle':
      return '대기'
    case 'requesting':
      return '권한 요청'
    case 'recording':
      return '녹화 중'
    case 'stopped':
      return '저장 준비'
    case 'error':
      return '오류'
  }
}

function StatCard({ label, value, accent }: { label: string; value: string; accent: string }) {
  const isLongValue = value.length > 8
  return (
    <div style={{ ...statCardStyle, borderColor: `${accent}55` }}>
      <div style={{ fontSize: 10, color: '#8ea2c2', marginBottom: 5 }}>{label}</div>
      <div
        style={{
          fontSize: isLongValue ? 12 : 15,
          fontWeight: 700,
          color: accent,
          lineHeight: 1.15,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
        title={value}
      >
        {value}
      </div>
    </div>
  )
}

const logoStyle: React.CSSProperties = {
  display: 'grid',
  placeItems: 'center',
  width: 42,
  height: 42,
  borderRadius: 12,
  background: 'linear-gradient(145deg, #ff6978, #b3293d)',
  color: '#fff',
  fontSize: 11,
  fontWeight: 900,
  letterSpacing: '0.12em',
  boxShadow: '0 12px 32px rgba(179,41,61,0.35)',
}

const heroStyle: React.CSSProperties = {
  display: 'flex',
  gap: 14,
  alignItems: 'stretch',
  flexWrap: 'nowrap',
  flex: 1,
  minHeight: 0,
}

const leftColumnStyle: React.CSSProperties = {
  flex: '1 1 0',
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'flex-start',
  minHeight: 0,
}

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: '#f2f7ff',
  marginBottom: 10,
}

const toggleRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginTop: 14,
  fontSize: 12,
  color: '#dbe5f7',
}

const actionBtnStyle: React.CSSProperties = {
  border: 'none',
  borderRadius: 10,
  color: '#fff',
  fontSize: 12,
  fontWeight: 700,
  padding: '9px 12px',
  cursor: 'pointer',
  boxShadow: '0 10px 24px rgba(0,0,0,0.22)',
}

const actionGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 8,
  marginTop: 14,
}

const leftInfoGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 10,
  marginTop: 14,
}

const statGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(120px, 1fr))',
  gap: 10,
  marginTop: 10,
}

const sourceCardStyle: React.CSSProperties = {
  marginTop: 14,
  padding: 12,
  borderRadius: 12,
  background: 'rgba(8, 13, 23, 0.5)',
  border: '1px solid rgba(143, 182, 255, 0.2)',
  backdropFilter: 'blur(14px)',
}

const statCardStyle: React.CSSProperties = {
  background: 'rgba(8, 13, 23, 0.5)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 12,
  padding: '10px 11px',
  backdropFilter: 'blur(14px)',
}

const previewPanelStyle: React.CSSProperties = {
  flex: '1 1 0',
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: 14,
  borderRadius: 18,
  background: 'rgba(8, 14, 24, 0.55)',
  border: '1px solid rgba(120, 156, 214, 0.2)',
  boxShadow: '0 20px 60px rgba(0,0,0,0.28)',
  minHeight: 0,
}

const previewHeaderStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  fontSize: 12,
  fontWeight: 700,
  color: '#f2f7ff',
}

const videoStyle: React.CSSProperties = {
  width: '100%',
  aspectRatio: '16 / 10',
  objectFit: 'contain',
  background: 'linear-gradient(135deg, #0a1019, #17263c)',
  borderRadius: 14,
  border: '1px solid rgba(137, 167, 215, 0.18)',
}

const errorStyle: React.CSSProperties = {
  marginTop: 14,
  padding: '10px 12px',
  borderRadius: 10,
  background: 'rgba(107, 35, 49, 0.45)',
  border: '1px solid rgba(255, 122, 145, 0.25)',
  color: '#ffd8df',
  fontSize: 12,
}

const miniActionBtnStyle: React.CSSProperties = {
  padding: '5px 9px',
  borderRadius: 6,
  border: '1px solid #4267a8',
  background: '#243a62',
  color: '#dce7ff',
  fontSize: 11,
  fontWeight: 700,
  cursor: 'pointer',
  lineHeight: 1,
  flexShrink: 0,
}
