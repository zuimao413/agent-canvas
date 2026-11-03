import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Excalidraw, restoreElements, exportToBlob } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'

function signature(elements) {
  return elements.map((e) => `${e.id}:${e.version}:${e.versionNonce}`).join('|')
}

let toastTimer = null
function toast(text, ms = 2200) {
  const node = document.getElementById('toast')
  if (!node) return
  node.textContent = text
  node.classList.add('show')
  if (toastTimer) window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => node.classList.remove('show'), ms)
}

function normalize(list) {
  if (!Array.isArray(list)) return []
  try {
    return restoreElements(list, null, { refreshDimensions: true, repairBindings: true })
  } catch (error) {
    console.error('restore failed', error)
    return []
  }
}

// 只记住「他自己选的」界面明暗和画布底色，刷新后还原。
// 不替他选、不覆盖：他不点，这里就不动。
const UI_KEY = 'canvas-ui-v1'

function readUI() {
  try {
    const raw = window.localStorage.getItem(UI_KEY)
    if (!raw) return null
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object') return null
    return value
  } catch {
    return null
  }
}

function writeUI(next) {
  try {
    const num = (v, fallback) => {
      const n = Number(v)
      return Number.isFinite(n) ? n : fallback
    }
    const zoom = Math.min(30, Math.max(0.1, num(next.zoom, 1)))
    window.localStorage.setItem(
      UI_KEY,
      JSON.stringify({
        theme: next.theme,
        viewBackgroundColor: next.viewBackgroundColor,
        scrollX: num(next.scrollX, 0),
        scrollY: num(next.scrollY, 0),
        zoom,
      }),
    )
  } catch {
    /* 忽略 */
  }
}

const SAVED_UI = readUI()

// 底色和画笔颜色都交给 Excalidraw 自己管（左上角菜单里的「画布背景」）。
// 这里不再覆盖任何 appState 颜色，避免跟用户的手动设置打架。
function App() {
  const api = useRef(null)
  const skip = useRef('')
  const sent = useRef('')
  const timer = useRef(null)
  const shot = useRef(null)
  const saveTimer = useRef(null)
  const lastApp = useRef(null)
  const lastView = useRef(null)
  const boardRef = useRef('')

  const [agent, setAgent] = useState('AI')
  const [boards, setBoards] = useState([])
  const [currentId, setCurrentId] = useState('')
  const [editingId, setEditingId] = useState('')
  const [draft, setDraft] = useState('')
  const [confirmId, setConfirmId] = useState('')
  const editingRef = useRef('')
  const confirmTimer = useRef(null)

  // 界面设置 + 视角，攒 150 毫秒写一次，避免拖动时狂写本地存储
  const scheduleSave = () => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null
      const app = lastApp.current || {}
      const view = lastView.current || app
      writeUI({
        theme: app.theme,
        viewBackgroundColor: app.viewBackgroundColor,
        scrollX: view.scrollX,
        scrollY: view.scrollY,
        zoom: view.zoom,
      })
    }, 150)
  }

  const scheduleExport = () => {
    if (shot.current !== null) window.clearTimeout(shot.current)
    shot.current = window.setTimeout(() => {
      shot.current = null
      if (!api.current) return
      const state = api.current.getAppState()
      exportToBlob({
        elements: api.current.getSceneElements(),
        appState: {
          ...state,
          exportBackground: true,
          viewBackgroundColor: state.viewBackgroundColor,
        },
        files: api.current.getFiles(),
        mimeType: 'image/png',
        exportPadding: 16,
      })
        .then((blob) => fetch('/api/snapshot', { method: 'POST', body: blob }))
        .catch(() => {})
    }, 700)
  }

  // 切到抓手：多重兜底，任一条能生效即可
  const goHand = () => {
    const inst = api.current
    if (!inst) return false
    try {
      const state = inst.getAppState && inst.getAppState()
      if (state && state.editingElement) return false
    } catch {}
    try {
      if (inst.setActiveTool) inst.setActiveTool({ type: 'hand' })
    } catch {}
    try {
      inst.updateScene({
        appState: {
          activeTool: { type: 'hand', customType: null, locked: false, lastActiveTool: null },
          selectedElementIds: {},
        },
      })
    } catch {}
    return true
  }

  const applyScene = (list, merge) => {
    if (!api.current) return false
    const incoming = normalize(list)
    if (incoming.length === 0) return false
    let valid = incoming
    if (merge === true) {
      const base = api.current.getSceneElements()
      const known = new Set(base.map((element) => element.id))
      valid = normalize([...base, ...incoming.filter((element) => !known.has(element.id))])
    }
    skip.current = signature(valid)
    sent.current = skip.current
    api.current.updateScene({ elements: valid })
    scheduleExport()
    return true
  }

  // 切到空话题：把画面清干净，别把上一个话题的东西带过去
  const clearScene = () => {
    if (!api.current) return
    skip.current = ''
    sent.current = ''
    api.current.updateScene({ elements: [] })
    scheduleExport()
  }

  const showBoard = (data) => {
    if (!data || data.error) {
      toast('切不过去：' + ((data && data.error) || '未知'), 3000)
      return
    }
    boardRef.current = data.current
    setCurrentId(data.current)
    if (Array.isArray(data.boards)) setBoards(data.boards)
    skip.current = ''
    sent.current = ''
    if (Array.isArray(data.elements) && data.elements.length > 0) applyScene(data.elements, false)
    else clearScene()
    // 切过去要看得见东西：把视角对到这一块内容上
    if (Array.isArray(data.elements) && data.elements.length > 0) {
      window.setTimeout(() => {
        try {
          if (api.current && api.current.scrollToContent) {
            api.current.scrollToContent(api.current.getSceneElements(), { fitToContent: true })
          }
        } catch {
          /* 忽略 */
        }
      }, 120)
    }
    window.setTimeout(goHand, 200)
  }

  const switchTo = (id) => {
    if (!id || id === boardRef.current) return
    fetch('/api/boards/select', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
      .then((r) => r.json())
      .then(showBoard)
      .catch(() => toast('切不过去：连不上', 3000))
  }

  const createBoard = () => {
    fetch('/api/boards', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '新话题' }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (!data || !data.board) return
        switchTo(data.board.id)
        beginRename(data.board)
      })
      .catch(() => toast('没建成', 3000))
  }

  const beginRename = (b) => {
    editingRef.current = b.id
    setEditingId(b.id)
    setDraft(b.name)
  }

  const endRename = () => {
    editingRef.current = ''
    setEditingId('')
  }

  const commitRename = (id) => {
    if (editingRef.current !== id) return
    const name = draft.trim()
    endRename()
    if (!name) return
    fetch('/api/boards/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, name }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data && data.boards) setBoards(data.boards)
        else if (data && data.error) toast(data.error, 3000)
      })
      .catch(() => toast('改名没成', 3000))
  }

  const deleteBoard = (b) => {
    setConfirmId('')
    fetch('/api/boards/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: b.id }),
    })
      .then((r) => r.json())
      .then(showBoard)
      .catch(() => toast('没删成', 3000))
  }

  useEffect(() => {
    let cancelled = false
    let tries = 0

    const loadInitial = () => {
      if (cancelled) return
      if (!api.current) {
        if (tries++ < 50) window.setTimeout(loadInitial, 100)
        return
      }
      fetch('/api/config')
        .then((r) => r.json())
        .then((data) => {
          if (!cancelled && data && data.agent) setAgent(data.agent)
        })
        .catch(() => {})
      fetch('/api/boards')
        .then((r) => r.json())
        .then((data) => {
          if (cancelled) return
          if (Array.isArray(data.boards)) setBoards(data.boards)
          boardRef.current = data.current || ''
          setCurrentId(data.current || '')
          return fetch('/api/elements')
        })
        .then((r) => (r ? r.json() : null))
        .then((data) => {
          if (cancelled || !data) return
          applyScene(data.elements)
        })
        .catch(() => {})
    }
    loadInitial()

    const source = new EventSource('/events')
    source.onopen = () => {}
    source.onerror = () => toast('画布断线，正在重连', 3000)
    source.onmessage = (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (message.type === 'boards') {
        if (Array.isArray(message.boards)) setBoards(message.boards)
        return
      }
      if (message.type !== 'scene') return
      // 别的话题的动静，这页不看
      if (message.boardId && message.boardId !== boardRef.current) return
      applyScene(message.elements, message.replace !== true)
      // agent 画完之后自动切回抓手，防止误触删掉内容
      goHand()
    }

    return () => {
      cancelled = true
      source.close()
    }
  }, [])

  // 反引号键（数字行最左边那个「·」）或 F9：叫醒 agent（要服务端配了 CANVAS_PING_URL）
  useEffect(() => {
    let lastFire = 0
    const PING_KEYS = ['`', '·', 'F9']
    const isTyping = (event) => {
      const el = event.target
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return true
      try {
        const state = api.current && api.current.getAppState && api.current.getAppState()
        return !!(state && state.editingElement)
      } catch {
        return false
      }
    }
    const onKey = (event) => {
      if (!PING_KEYS.includes(event.key)) return
      if (event.repeat) return
      if (isTyping(event)) return
      event.preventDefault()
      const now = Date.now()
      if (now - lastFire < 4000) return
      lastFire = now
      fetch('/api/ping', { method: 'POST' })
        .then((r) => r.json())
        .then((data) => {
          if (!data || !data.ok) toast('没叫醒 ' + agent + '：' + ((data && data.error) || '未知'), 3000)
        })
        .catch(() => toast('没叫醒 ' + agent + '：连不上'))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [agent])

  const onChange = (elements, appState) => {
    if (appState) {
      lastApp.current = appState
      scheduleSave()
    }
    const sig = signature(elements)
    if (sig === skip.current || sig === sent.current) return
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      timer.current = null
      sent.current = sig
      fetch('/api/elements', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ elements }),
      }).catch(() => {})
      scheduleExport()
    }, 250)
  }

  const tabStyle = (active) => ({
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 12px',
    borderRadius: 999,
    border: '1px solid ' + (active ? '#5a5a62' : 'transparent'),
    background: active ? '#3a3a40' : 'transparent',
    color: active ? '#ffffff' : '#a8a8b0',
    font: '13px/1.4 system-ui, "Microsoft YaHei", sans-serif',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  })

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 12px',
          background: '#1e1e1e',
          borderBottom: '1px solid #333',
          overflowX: 'auto',
          overflowY: 'hidden',
          flexShrink: 0,
        }}
      >
        {boards.map((b) => {
          const active = b.id === currentId
          const editing = editingId === b.id
          return (
            <div
              key={b.id}
              onClick={() => {
                if (editing) return
                switchTo(b.id)
              }}
              onDoubleClick={() => {
                if (!editing) beginRename(b)
              }}
              title={editing ? '' : '双击改名'}
              style={{ ...tabStyle(active), cursor: editing ? 'text' : 'pointer' }}
            >
              {editing ? (
                <input
                  autoFocus
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commitRename(b.id)
                    if (event.key === 'Escape') endRename()
                  }}
                  onBlur={() => commitRename(b.id)}
                  onClick={(event) => event.stopPropagation()}
                  style={{
                    width: Math.max(64, draft.length * 14 + 16) + 'px',
                    background: '#26262a',
                    color: '#ffffff',
                    border: '1px solid #6a6a74',
                    borderRadius: 6,
                    padding: '1px 6px',
                    font: '13px/1.4 system-ui, "Microsoft YaHei", sans-serif',
                    outline: 'none',
                  }}
                />
              ) : (
                <span>{b.name}</span>
              )}
              {!editing && active ? (
                <span
                  onClick={(event) => {
                    event.stopPropagation()
                    beginRename(b)
                  }}
                  title="改名"
                  style={{ color: '#9a9aa4', fontSize: 13, lineHeight: 1, paddingLeft: 2 }}
                >
                  ✎
                </span>
              ) : null}
              {!editing && active && boards.length > 1 ? (
                <span
                  onClick={(event) => {
                    event.stopPropagation()
                    if (confirmId === b.id) {
                      deleteBoard(b)
                      return
                    }
                    setConfirmId(b.id)
                    if (confirmTimer.current) window.clearTimeout(confirmTimer.current)
                    confirmTimer.current = window.setTimeout(() => setConfirmId(''), 4000)
                  }}
                  title="删掉这个话题"
                  style={{
                    color: confirmId === b.id ? '#ff6b6b' : '#8a8a92',
                    fontSize: confirmId === b.id ? 12 : 15,
                    lineHeight: 1,
                    paddingLeft: 2,
                  }}
                >
                  {confirmId === b.id ? '确认删' : '×'}
                </span>
              ) : null}
            </div>
          )
        })}
        <button onClick={createBoard} style={{ ...tabStyle(false), border: '1px dashed #4a4a52' }}>
          ＋ 新话题
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <Excalidraw
          excalidrawAPI={(instance) => {
            api.current = instance
            window.setTimeout(goHand, 400)
          }}
          onChange={onChange}
          onScrollChange={(scrollX, scrollY, zoom) => {
            lastView.current = {
              scrollX,
              scrollY,
              zoom: typeof zoom === 'number' ? zoom : zoom && zoom.value,
            }
            scheduleSave()
          }}
          langCode="zh-CN"
          initialData={
            SAVED_UI
              ? {
                  appState: {
                    theme: SAVED_UI.theme === 'dark' ? 'dark' : 'light',
                    ...(SAVED_UI.viewBackgroundColor
                      ? { viewBackgroundColor: SAVED_UI.viewBackgroundColor }
                      : {}),
                    ...(Number.isFinite(Number(SAVED_UI.scrollX))
                      ? { scrollX: Number(SAVED_UI.scrollX) }
                      : {}),
                    ...(Number.isFinite(Number(SAVED_UI.scrollY))
                      ? { scrollY: Number(SAVED_UI.scrollY) }
                      : {}),
                    ...(Number.isFinite(Number(SAVED_UI.zoom))
                      ? { zoom: { value: Math.min(30, Math.max(0.1, Number(SAVED_UI.zoom))) } }
                      : {}),
                  },
                }
              : undefined
          }
        />
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')).render(<App />)
