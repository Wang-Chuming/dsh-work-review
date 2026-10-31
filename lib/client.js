/**
 * client.js — client half：左侧栏全局面板「工作回顾」（plain JS，免构建）。
 *
 * 位置：主界面左栏 `sidebar.panellist`（order 20，排在「自动化任务」order 10 下方），
 * 点击后由布局的 `main` keyed slot 渲染整页。它是跨 session 的汇总，不是某个
 * session 的视图，所以不放 conversation 头部 tab（对话/轨迹）里。
 *
 * 注册契约（本 DSH 版本实测）：
 *   - window.__ModuleLoader__.load({ id: <包名>, factory(require) {...} })
 *   - React 从浏览器模块表拿：require('react')
 *   - 左栏条目：ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
 *       { name: 'sidebar.panellist', id, order, label }, IconComponent))
 *       条目接收 { size, active }，label 由 resolveSlotLabel 解析（函数/字符串均可）。
 *   - 面板正文：ctx.slots.inject('main', () => ctx.slots.register(
 *       { name: 'main', key: <同一 id>, inject: () => props }, PageComponent))
 *       路由由 ctx.layout.selectPanel(id) 驱动，返回对话用 ctx.layout.selectPanel(null)。
 *   - inject 返回的 props 会并入页面组件 props（这里传 layout，用于「返回对话」）。
 *   - 普通会话（session）的 slot 才会被注入 inputActions：
 *       captureInsertion() -> span（含 draftRev）
 *       insertText(text, span) -> boolean（版本有效且可编辑才插入；可 undo）
 *     全局面板没有 inputActions → 「插入输入框」退化为复制到剪贴板并提示。
 *
 * 版式（2026-10-30 重做，对齐内置面板页如 Plugins / Automation tasks）：
 *   - 页面自己撑满内容区（flex 撑高 + 内部滚动），不依赖祖先滚动容器，也不钉死像素高度；
 *   - 页面内容有统一的内边距与标题区，不贴窗口顶端；
 *   - 导航只有一条：顶部的「日报 / 周报」+ 日期/周下拉选择器，不再在左侧重复一列清单；
 *   - 正文先剥掉 YAML frontmatter 再渲染，标题只出现一次。
 *
 * 数据来自 host 的只读 API：/work-review/api/{index,report,routine}
 * 只读面板：不提供生成/写入口。
 */
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-work-review',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const API = '/work-review/api'
    const PANEL_ID = 'routine'
    const PANEL_VERSION = '0.4.0'

    // ---------------------------------------------------------------------
    // 样式（只用 --dsw-alias-* token；整块由组件渲染，卸载即消失）
    // ---------------------------------------------------------------------
    const CSS = `
.wr-shell{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;height:100%;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px}
.wr-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden}
.wr-inner{box-sizing:border-box;max-width:1040px;margin:0 auto;padding:36px 44px 64px}
.wr-header{display:flex;align-items:flex-start;gap:16px}
.wr-heading{flex:1 1 auto;min-width:0}
.wr-title{margin:0;font-size:20px;font-weight:650;letter-spacing:.2px}
.wr-sub{margin:5px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary);display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.wr-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px}
.wr-sep{color:var(--dsw-alias-state-idle-primary)}
.wr-actions{display:flex;align-items:center;gap:8px;flex:0 0 auto;padding-top:2px}
.wr-btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:7px;height:28px;padding:0 12px;cursor:pointer;font:inherit;font-size:12px;white-space:nowrap}
.wr-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.wr-btn[disabled]{opacity:.45;cursor:default}
.wr-btn-primary{border-color:var(--dsw-alias-label-primary);background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base)}
.wr-btn-primary:hover{background:var(--dsw-alias-label-primary);opacity:.9}
.wr-toolbar{display:flex;align-items:flex-end;gap:12px;margin-top:24px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.wr-tabs{display:flex;gap:20px;flex:0 0 auto}
.wr-tab{position:relative;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;padding:6px 2px 11px;cursor:pointer}
.wr-tab:hover{color:var(--dsw-alias-label-primary)}
.wr-tab[data-on="1"]{color:var(--dsw-alias-label-primary);font-weight:600}
.wr-tab[data-on="1"]:after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:2px;background:var(--dsw-alias-brand-primary)}
.wr-grow{flex:1 1 auto;min-width:0}
.wr-picker{display:flex;align-items:center;gap:4px;padding-bottom:7px;flex:0 0 auto}
.wr-nav{width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:1;cursor:pointer;padding:0}
.wr-nav:hover:not([disabled]){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.wr-nav[disabled]{opacity:.35;cursor:default}
.wr-select{height:26px;max-width:300px;min-width:170px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:0 6px}
.wr-status{flex:0 1 auto;max-width:46%;padding-bottom:9px;font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}
.wr-status[data-kind="ok"]{color:var(--dsw-alias-state-success-primary)}
.wr-status[data-kind="warn"]{color:var(--dsw-alias-state-warn-primary)}
.wr-status[data-kind="err"]{color:var(--dsw-alias-state-error-primary)}
.wr-doc{margin-top:26px}
.wr-doc-head{display:flex;flex-direction:column;gap:10px;margin-bottom:16px}
.wr-doc-top{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}
.wr-doc-title{margin:0;font-size:18px;font-weight:650;line-height:1.4}
.wr-review{display:flex;align-items:center;gap:8px;flex:0 0 auto;flex-wrap:wrap}
.wr-review-note{font-size:11px;color:var(--dsw-alias-state-idle-primary);max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wr-review-note[data-kind="ok"]{color:var(--dsw-alias-state-success-primary)}
.wr-review-note[data-kind="err"]{color:var(--dsw-alias-state-error-primary)}
.wr-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.wr-chip{display:inline-flex;align-items:center;max-width:100%;height:21px;padding:0 9px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wr-chip.wr-mono{font-size:10.5px}
.wr-chip-btn{display:inline-flex;align-items:center;height:21px;padding:0 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer}
.wr-chip-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.wr-prose{max-width:860px;font-size:13px;line-height:1.75}
.wr-p{margin:8px 0}
.wr-h2{margin:22px 0 8px;font-size:15px;font-weight:650;line-height:1.5}
.wr-h3{margin:18px 0 6px;font-size:13.5px;font-weight:650;line-height:1.5;color:var(--dsw-alias-brand-primary)}
.wr-h4{margin:14px 0 4px;font-size:12.5px;font-weight:650;line-height:1.5}
.wr-ul{margin:6px 0;padding-left:20px}
.wr-ul li{margin:4px 0}
.wr-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;background:var(--dsw-alias-bg-layer-2);border-radius:4px;padding:1px 5px}
.wr-pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:12px;overflow:auto;margin:10px 0;white-space:pre-wrap}
.wr-quote{border-left:3px solid var(--dsw-alias-border-l2);padding:2px 12px;color:var(--dsw-alias-label-secondary);margin:10px 0}
.wr-link{color:var(--dsw-alias-brand-primary);border-bottom:1px dashed var(--dsw-alias-border-l2)}
.wr-hr{height:1px;border:0;background:var(--dsw-alias-border-l1);margin:18px 0}
.wr-hint{margin-top:22px;padding:20px 22px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:1.8}
.wr-hint-title{display:block;margin-bottom:4px;color:var(--dsw-alias-label-primary);font-weight:600}
.wr-hint code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;background:var(--dsw-alias-bg-layer-2);border-radius:4px;padding:1px 5px}
.wr-foot{margin-top:44px;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l1);display:flex;flex-wrap:wrap;gap:8px;font-size:11px;color:var(--dsw-alias-state-idle-primary)}
`

    // ---------------------------------------------------------------------
    // 工具
    // ---------------------------------------------------------------------
    function fetchJson(path) {
      return fetch(API + path, { headers: { accept: 'application/json' } }).then((r) => r.json())
    }

    /** POST JSON，返回解析后的响应体（不因 HTTP 状态码抛错）。 */
    function postJson(path, payload) {
      return fetch(API + path, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(payload || {}),
      }).then((r) => r.json())
    }

    /** 把秒数写成 3s / 2m05s / 1h02m 这种短形式。 */
    function formatElapsed(seconds) {
      const total = Math.max(0, Math.round(Number(seconds) || 0))
      if (total < 60) return `${total}s`
      const minutes = Math.floor(total / 60)
      if (minutes < 60) return `${minutes}m${String(total % 60).padStart(2, '0')}s`
      return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
    }

    /** 「执行自动审批」的一行状态文案。 */
    function approveStatusLabel(state) {
      if (!state || !state.status) return ''
      switch (state.status) {
        case 'starting':
          return '正在启动自动审批…'
        case 'running':
          return `自动审批运行中 ${formatElapsed(state.elapsedSec)}`
        case 'done':
          return '自动审批已完成（退出码 0）'
        case 'failed':
          return state.exitCode === null || state.exitCode === undefined
            ? '自动审批失败（无退出码）'
            : `自动审批失败（退出码 ${state.exitCode}）`
        case 'unknown':
          return '自动审批进程已不在（宿主可能重启过），请查看日志'
        default:
          return ''
      }
    }

    function copyToClipboard(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text)
          return true
        }
      } catch (err) {
        /* 落到 false，由调用方提示 */
      }
      return false
    }

    /** 行内格式：**粗体**、`代码`、[[wikilink]]、$公式$。 */
    function renderInline(text, keyPrefix) {
      const source = String(text ?? '')
      const nodes = []
      const re = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[\[[^\]\n]+\]\]|\$[^$\n]+\$)/g
      let last = 0
      let match
      let n = 0
      while ((match = re.exec(source)) !== null) {
        if (match.index > last) nodes.push(source.slice(last, match.index))
        const token = match[0]
        const key = `${keyPrefix}-i${n++}`
        if (token.startsWith('**')) {
          nodes.push(h('strong', { key }, token.slice(2, -2)))
        } else if (token.startsWith('`')) {
          nodes.push(h('code', { key, className: 'wr-code' }, token.slice(1, -1)))
        } else if (token.startsWith('[[')) {
          const inner = token.slice(2, -2)
          const label = inner.includes('|') ? inner.split('|').pop() : inner.split('/').pop()
          nodes.push(h('span', { key, className: 'wr-link', title: inner }, label))
        } else {
          nodes.push(h('code', { key, className: 'wr-code' }, token.slice(1, -1)))
        }
        last = match.index + token.length
      }
      if (last < source.length) nodes.push(source.slice(last))
      return nodes
    }

    /** 极简 markdown → React（不引入第三方依赖，也不注入 HTML）。 */
    function renderMarkdown(markdown) {
      const lines = String(markdown ?? '').split('\n')
      const out = []
      let i = 0
      let key = 0
      const isBlockStart = (line) =>
        /^#{1,6}\s/.test(line) || /^\s*[-*]\s+/.test(line) || /^>\s?/.test(line) || /^```/.test(line)

      while (i < lines.length) {
        const line = lines[i]
        if (!line.trim() || /^<!--/.test(line) || /^<!--[\s\S]*-->$/.test(line.trim())) {
          i += 1
          continue
        }
        if (/^```/.test(line)) {
          const buf = []
          i += 1
          while (i < lines.length && !/^```/.test(lines[i])) {
            buf.push(lines[i])
            i += 1
          }
          i += 1
          out.push(h('pre', { key: `pre${key++}`, className: 'wr-pre' }, buf.join('\n')))
          continue
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading) {
          const level = Math.min(heading[1].length, 4)
          out.push(h('div', { key: `h${key++}`, className: `wr-h${level}` }, renderInline(heading[2], `h${key}`)))
          i += 1
          continue
        }
        if (/^\s*[-*]\s+/.test(line)) {
          const items = []
          while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
            items.push(h('li', { key: `li${key++}` }, renderInline(lines[i].replace(/^\s*[-*]\s+/, ''), `l${key}`)))
            i += 1
          }
          out.push(h('ul', { key: `ul${key++}`, className: 'wr-ul' }, items))
          continue
        }
        if (/^>\s?/.test(line)) {
          const buf = []
          while (i < lines.length && /^>\s?/.test(lines[i])) {
            buf.push(lines[i].replace(/^>\s?/, ''))
            i += 1
          }
          out.push(h('div', { key: `q${key++}`, className: 'wr-quote' }, renderInline(buf.join(' '), `q${key}`)))
          continue
        }
        if (/^---+$/.test(line.trim())) {
          out.push(h('hr', { key: `hr${key++}`, className: 'wr-hr' }))
          i += 1
          continue
        }
        const para = [line]
        i += 1
        while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
          para.push(lines[i])
          i += 1
        }
        out.push(h('p', { key: `p${key++}`, className: 'wr-p' }, renderInline(para.join(' '), `p${key}`)))
      }
      return out
    }

    /**
     * 拆 frontmatter 与标题：文件原文里的 YAML 头不该出现在正文；
     * 标题取 frontmatter.title，其次首个 H1，并把它从正文里摘掉（避免标题重复两遍）。
     */
    function parseDoc(markdown) {
      let body = String(markdown ?? '')
      const meta = {}
      const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(body)
      if (fm) {
        body = body.slice(fm[0].length)
        for (const line of fm[1].split(/\r?\n/)) {
          const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
          if (m && m[2] && !m[2].startsWith('[') && !m[2].startsWith('{')) {
            meta[m[1]] = m[2].replace(/^["']|["']$/g, '')
          }
        }
      }
      let title = meta.title || ''
      // 文件正文开头常先有生成标记注释，再是一级标题（常带 emoji 前缀），与
      // frontmatter.title 重复：找到第一行「真实内容」，若是 H1 就摘掉。
      const lines = body.split(/\r?\n/)
      const isNoise = (line) => line.trim() === '' || /^<!--/.test(line.trim())
      const firstContent = lines.findIndex((line) => !isNoise(line))
      if (firstContent >= 0 && /^#[ \t]+\S/.test(lines[firstContent])) {
        const heading = lines[firstContent].replace(/^#[ \t]+/, '').trim()
        if (!title) title = heading
        lines.splice(firstContent, 1)
        body = lines.join('\n').replace(/^\s*\n/, '')
      }
      return { meta, title, body }
    }

    /** 从 Dream markdown 里取「昨日总结」区（插入输入框用）。 */
    function dayQuote(markdown, date) {
      const text = String(markdown ?? '')
      const m = /##\s*昨日总结\s*\n([\s\S]*?)(?=\n###\s|\n##\s|$)/.exec(text)
      const section = (m ? m[1] : text).trim()
      const lines = section.split('\n').map((l) => l.trim()).filter(Boolean)
      const picked = lines.slice(0, 4).join('\n')
      return `[[${date}]] 摘要：\n${picked}`
    }

    function formatRange(start, end) {
      if (!start || !end) return ''
      return `${start} → ${end}`
    }

    function baseName(p) {
      return String(p ?? '').split(/[/\\]/).filter(Boolean).pop() || ''
    }

    /**
     * 把审批模板里的占位符换成当前上下文：
     *   {date} 当前日期、{week} 当前 ISO 周、{title} 文档标题、{path} 文档相对路径、{vault} vault 路径。
     * 模板本身来自用户配置（~/.dsh/work-review.json 的 review.command），插件不内置任何工作流。
     */
    function buildReviewPrompt(template, context) {
      const values = {
        date: context?.date || '',
        week: context?.week || '',
        title: context?.title || '',
        path: context?.path || '',
        vault: context?.vault || '',
      }
      return String(template ?? '').replace(/\{(date|week|title|path|vault)\}/g, (match, key) =>
        values[key] ?? match,
      )
    }

    // ---------------------------------------------------------------------
    // 「插入输入框」：captureInsertion + insertText（版本有效才生效，可 undo）
    // ---------------------------------------------------------------------
    function useInsertion() {
      const [status, setStatus] = React.useState(null)
      const timer = React.useRef(null)
      React.useEffect(() => () => clearTimeout(timer.current), [])
      const say = (kind, text) => {
        setStatus({ kind, text })
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setStatus(null), 6000)
      }
      const insert = (text, inputActions) => {
        if (!text) return say('warn', '没有可插入的内容')
        if (!inputActions || typeof inputActions.insertText !== 'function') {
          const copied = copyToClipboard(text)
          return say(
            'warn',
            copied ? '面板独立于会话：已复制到剪贴板，切回「对话」后粘贴' : '输入框不可用，复制也失败',
          )
        }
        try {
          // captureInsertion → insertText 是 CAS：版本过期返回 false，用新版本再试一次
          let ok = inputActions.insertText(text, inputActions.captureInsertion())
          if (!ok) ok = inputActions.insertText(text, inputActions.captureInsertion())
          if (ok) return say('ok', '已插入输入框（可撤销，不会覆盖已有草稿）')
          const copied = copyToClipboard(text)
          return say(
            'warn',
            copied
              ? '插入被拒绝（草稿版本已变或编辑器忙碌），已复制到剪贴板：切回 Chat 视图后粘贴'
              : '插入被拒绝，复制也失败：切回 Chat 视图后重试',
          )
        } catch (err) {
          const copied = copyToClipboard(text)
          return say('err', `插入异常：${err && err.message ? err.message : err}${copied ? '（已复制）' : ''}`)
        }
      }
      return { status, insert, say }
    }

    // ---------------------------------------------------------------------
    // 面板
    // ---------------------------------------------------------------------
    /** 左栏条目图标：renderSlot 传入 { size, active }，用 currentColor 跟随主题。 */
    function RoutineIcon(props) {
      const size = (props && Number(props.size)) || 18
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('rect', { x: 3.5, y: 4.5, width: 17, height: 15, rx: 2.5 }),
        h('path', { d: 'M7.5 9.5h9M7.5 13h9M7.5 16.5h5.5' }),
      )
    }

    function RoutineView(props) {
      const inputActions = props && props.inputActions ? props.inputActions : null
      // 默认日报：日报频率更高（设计默认是周报，实测日报更常用）
      const [tab, setTab] = React.useState('day')
      const [index, setIndex] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [week, setWeek] = React.useState('')
      const [routine, setRoutine] = React.useState(null)
      const [date, setDate] = React.useState('')
      const [dayData, setDayData] = React.useState(null)
      const [approveState, setApproveState] = React.useState(null)
      const approveTimer = React.useRef(null)
      const { status, insert, say } = useInsertion()

      React.useEffect(() => () => clearTimeout(approveTimer.current), [])

      const loadWeek = React.useCallback((targetWeek) => {
        if (!targetWeek) return
        setWeek(targetWeek)
        setBusy(true)
        fetchJson(`/routine?week=${encodeURIComponent(targetWeek)}`)
          .then((data) => setRoutine(data))
          .catch((err) => setRoutine({ ok: false, error: String(err) }))
          .finally(() => setBusy(false))
      }, [])

      const loadDay = React.useCallback((targetDate) => {
        if (!targetDate) return
        setDate(targetDate)
        setBusy(true)
        fetchJson(`/report?date=${encodeURIComponent(targetDate)}`)
          .then((data) => setDayData(data))
          .catch((err) => setDayData({ ok: false, error: String(err) }))
          .finally(() => setBusy(false))
      }, [])

      React.useEffect(() => {
        let alive = true
        setBusy(true)
        fetchJson('/index')
          .then((data) => {
            if (!alive) return
            setIndex(data)
            if (!data || !data.ok) {
              setError((data && data.error) || 'index 加载失败')
              return
            }
            setError('')
            const current = data.routines.find((r) => r.week === data.currentWeek)
            const firstWeek = current ? current.week : data.routines[0] && data.routines[0].week
            if (firstWeek) loadWeek(firstWeek)
            if (data.days.length) loadDay(data.days[0].date)
          })
          .catch((err) => alive && setError(String(err)))
          .finally(() => alive && setBusy(false))
        return () => {
          alive = false
        }
      }, [loadWeek, loadDay])

      const weeks = (index && index.routines) || []
      const days = (index && index.days) || []
      const vaultLabel = baseName(index && index.vault) || 'vault'

      // 下拉选择器的前后跳转：列表是新的在前，所以 ‹ 去更早、› 回更新。
      const pickerList = tab === 'week' ? weeks : days
      const pickerKey = tab === 'week' ? 'week' : 'date'
      const pickerValue = tab === 'week' ? week : date
      const pickerIndex = pickerList.findIndex((item) => item[pickerKey] === pickerValue)
      const select = (target) => {
        if (tab === 'week') loadWeek(target)
        else loadDay(target)
      }
      const step = (delta) => {
        const next = pickerList[pickerIndex + delta]
        if (next) select(next[pickerKey])
      }

      const routineDoc = routine && routine.ok ? parseDoc(routine.markdown || routine.body || '') : null
      const weekQuote = routine && routine.ok ? routine.quote || (routineDoc ? routineDoc.body.slice(0, 1200) : '') : ''

      const dayPreferred = dayData && dayData.ok ? dayData.preferred : null
      const daySource = dayData && dayData.ok && dayPreferred ? dayData[dayPreferred] : null
      const dayDoc = daySource ? parseDoc(daySource.markdown || '') : null
      const dayInsertText = dayData && dayData.ok ? dayQuote(dayDoc ? dayDoc.body : '', dayData.date) : ''

      const copy = (text) => {
        if (!text) return say('warn', '没有可复制的内容')
        const ok = copyToClipboard(text)
        say(ok ? 'ok' : 'err', ok ? `已复制 ${text.length} 字符` : '复制失败（浏览器未授权剪贴板）')
      }

      // 「去审批」：完全由配置驱动（~/.dsh/work-review.json 的 review 段）。
      // 默认只新建会话并预填草案、不发送；review.autoSend 为 true 才直接发送。
      const review =
        index && index.ok && index.review && index.review.command && index.review.command.trim()
          ? index.review
          : null
      const reviewContext = () => ({
        date: dayData && dayData.ok ? dayData.date : date,
        week,
        title: (dayDoc && dayDoc.title) || '',
        path: daySource && daySource.path ? daySource.path : '',
        vault: (index && index.vault) || '',
      })

      // 「执行自动审批」：host 直接 spawn vault 脚本（配置的 approve 段），
      // 不新开会话；面板轮询状态，完成/失败后刷新当前日报。
      const approve =
        index && index.ok && index.approve && index.approve.label ? index.approve : null
      const approveDate = () => (dayData && dayData.ok ? dayData.date : date)
      const approveBusy = approveState && (approveState.status === 'running' || approveState.status === 'starting')
      const approveKind =
        approveState && approveState.status === 'done'
          ? 'ok'
          : approveState && approveState.status === 'failed'
            ? 'err'
            : ''

      const readApprove = React.useCallback(
        (targetDate) =>
          fetchJson(`/approve?date=${encodeURIComponent(targetDate)}`).catch(() => null),
        [],
      )

      // 切日期时同步一次状态（别的窗口/昨夜的运行也能被看见）。
      React.useEffect(() => {
        clearTimeout(approveTimer.current)
        if (!approve) {
          setApproveState(null)
          return undefined
        }
        const targetDate = dayData && dayData.ok ? dayData.date : date
        if (!targetDate) return undefined
        let alive = true
        readApprove(targetDate).then((state) => {
          if (!alive || !state) return
          if (state.configured === false) setApproveState(null)
          else setApproveState(state)
        })
        return () => {
          alive = false
        }
      }, [approve, date, dayData, readApprove])

      const pollApprove = (targetDate) => {
        clearTimeout(approveTimer.current)
        let tries = 0
        const tick = async () => {
          if (tries > 1440) return // ~1.2h 上限，避免面板一直轮询
          tries += 1
          const state = await readApprove(targetDate)
          if (!state) {
            approveTimer.current = setTimeout(tick, 5000)
            return
          }
          setApproveState(state)
          if (state.status === 'running') {
            approveTimer.current = setTimeout(tick, 3000)
            return
          }
          loadDay(targetDate)
        }
        tick()
      }

      const startApprove = async () => {
        if (!approve) return
        const targetDate = approveDate()
        if (!targetDate) return say('warn', '先选一天再执行自动审批')
        setApproveState({ status: 'starting' })
        try {
          const result = await postJson('/approve', { date: targetDate })
          if (!result || result.ok === false) {
            setApproveState({ status: 'failed', error: (result && result.error) || '启动失败' })
            return say('err', `自动审批启动失败：${(result && result.error) || '未知原因'}`)
          }
          setApproveState(result)
          say('ok', result.started === false ? '这一天已经在跑自动审批' : '已启动自动审批（后台运行，可关掉面板）')
          pollApprove(targetDate)
        } catch (err) {
          setApproveState({ status: 'failed', error: String(err) })
          say('err', `自动审批启动失败：${err}`)
        }
      }

      const reviewServices = props && props.services ? props.services : null
      const serviceOf = (key) => {
        try {
          return reviewServices && typeof reviewServices[key] === 'function'
            ? reviewServices[key]()
            : null
        } catch {
          return null
        }
      }
      const startReview = async () => {
        if (!review) return
        const prompt = buildReviewPrompt(review.command, reviewContext())
        if (!prompt.trim()) return say('warn', '审批模板是空的，检查配置里的 review.command')

        const uiWorkspace = serviceOf('uiWorkspace')
        const openDraft = () => {
          if (!uiWorkspace || typeof uiWorkspace.startSession !== 'function') return false
          uiWorkspace.startSession(undefined, { prompt, whenDraftExists: 'append' })
          return true
        }

        if (!review.autoSend) {
          try {
            if (openDraft()) return say('ok', '已新建会话，审批指令已填好：按回车发送')
          } catch {
            // 落到底部的复制降级
          }
          const copied = copyToClipboard(prompt)
          return say(
            'warn',
            copied
              ? '当前窗口不支持新建会话：审批指令已复制到剪贴板，可粘贴到 Chat'
              : '当前窗口不支持新建会话，复制也失败',
          )
        }

        const sessions = serviceOf('sessions')
        try {
          if (!sessions || typeof sessions.create !== 'function') throw new Error('会话服务不可用')
          const sessionId = await sessions.create(review.agentPreset ? { agentPreset: review.agentPreset } : {})
          const ref = sessions.retain(sessionId, { source: 'controllerOperation' })
          await ref.ready
          const result = await ref.binding.session.prompt([{ type: 'text', text: prompt }], 'queue')
          if (result && result.ok === false) {
            throw new Error(result.error && result.error.message ? result.error.message : '发送被拒绝')
          }
          if (uiWorkspace && typeof uiWorkspace.openSession === 'function') uiWorkspace.openSession(sessionId)
          return say('ok', '已新建会话并发送审批指令')
        } catch (err) {
          const copied = copyToClipboard(prompt)
          return say(
            'err',
            `一键发送失败：${err && err.message ? err.message : err}${copied ? '（审批指令已复制）' : ''}`,
          )
        }
      }

      const layout = props && props.layout ? props.layout : null
      const headerActions = []
      if (layout && typeof layout.selectPanel === 'function') {
        headerActions.push(
          h(
            'button',
            {
              key: 'back',
              className: 'wr-btn',
              title: '返回对话（本面板是全局汇总面板，不属于任何 session）',
              onClick: () => layout.selectPanel(null),
            },
            '返回对话',
          ),
        )
      }
      headerActions.push(
        h(
          'button',
          {
            key: 'insert',
            className: 'wr-btn wr-btn-primary',
            title: '把当前结论插入 Chat 输入框（可 undo，不覆盖草稿）',
            onClick: () => insert(tab === 'week' ? weekQuote : dayInsertText, inputActions),
          },
          '插入输入框',
        ),
      )
      headerActions.push(
        h(
          'button',
          {
            key: 'copy',
            className: 'wr-btn',
            title: '复制当前 Markdown 原文',
            onClick: () =>
              copy(
                tab === 'week'
                  ? routine && routine.ok
                    ? routine.markdown || routine.body || ''
                    : ''
                  : daySource
                    ? daySource.markdown || ''
                    : '',
              ),
          },
          '复制',
        ),
      )
      headerActions.push(
        h(
          'button',
          {
            key: 'reload',
            className: 'wr-btn',
            title: '重新读取（面板只读，不触发生成）',
            onClick: () => {
              if (tab === 'week') loadWeek(week)
              else loadDay(date)
            },
          },
          '刷新',
        ),
      )

      const options = pickerList.map((item) => {
        if (tab === 'week') {
          return h('option', { key: item.week, value: item.week }, `${item.week} · ${formatRange(item.start, item.end)}`)
        }
        const badge = [item.dream ? 'Dream' : '', item.journal ? 'journal' : ''].filter(Boolean).join('/')
        return h('option', { key: item.date, value: item.date }, badge ? `${item.date} · ${badge}` : item.date)
      })

      const statusText = status ? status.text : busy ? '读取中…' : ''
      const statusKind = status ? status.kind : ''

      const body = []
      const chips = []
      let docTitle = ''

      if (!index || !index.ok) {
        body.push(
          h(
            'div',
            { key: 'hint', className: 'wr-hint' },
            h('span', { className: 'wr-hint-title' }, error || '数据还没有加载好'),
            '工作回顾读取的是本机 vault 里的 life/dreams、life/journal、life/routines。',
            h('br'),
            '若提示 vault 未配置：用 ',
            h('code', {}, '--vault <path>'),
            '、环境变量 ',
            h('code', {}, 'DSH_WORK_REVIEW_VAULT'),
            '，或 ',
            h('code', {}, '~/.dsh/work-review.json'),
            ' 指定 vault 根目录。',
          ),
        )
      } else if (tab === 'week') {
        if (!routine || !routine.ok || !routineDoc) {
          body.push(
            h(
              'div',
              { key: 'hint', className: 'wr-hint' },
              h('span', { className: 'wr-hint-title' }, routine && routine.error ? `读取失败：${routine.error}` : '这一周还没有周报'),
              '周报由插件自带的 CLI 生成（见 README 的 Usage 一节）：',
              h('code', {}, `--week ${week || '<YYYY-Www>'}`),
              '；面板只读，不会替你写入文件。',
            ),
          )
        } else {
          // 标题里的日期范围已在 chips 里，标题只留周号
          docTitle = (routineDoc.title || week).replace(/\s*[（(][^（()）]*[）)]\s*$/, '')
          chips.push(h('span', { key: 'range', className: 'wr-chip' }, formatRange(routine.start, routine.end)))
          if (routineDoc.meta.status) chips.push(h('span', { key: 'status', className: 'wr-chip' }, routineDoc.meta.status))
          if (routine.path) chips.push(h('span', { key: 'path', className: 'wr-chip wr-mono' }, routine.path))
          body.push(...renderMarkdown(routineDoc.body))
        }
      } else if (!dayDoc || !dayDoc.body.trim()) {
        body.push(
          h(
            'div',
            { key: 'hint', className: 'wr-hint' },
            h('span', { className: 'wr-hint-title' }, dayData && dayData.error ? `读取失败：${dayData.error}` : '这一天没有 Dream 或 journal'),
            dayData && dayData.date ? `${dayData.date} 在 life/dreams 与 life/journal 里都没有内容。` : '',
          ),
        )
      } else {
        docTitle = dayDoc.title || dayData.date
        chips.push(h('span', { key: 'source', className: 'wr-chip' }, dayPreferred === 'dream' ? 'Dream 早报' : 'journal'))
        if (daySource.path) chips.push(h('span', { key: 'path', className: 'wr-chip wr-mono' }, daySource.path))
        if (dayData.dream && dayData.journal) {
          chips.push(
            h(
              'button',
              {
                key: 'toggle',
                className: 'wr-chip-btn',
                title: `切到另一份 ${dayData.preferred === 'dream' ? 'journal' : 'Dream'}`,
                onClick: () =>
                  setDayData((prev) =>
                    prev && prev.ok
                      ? { ...prev, preferred: prev.preferred === 'dream' ? 'journal' : 'dream' }
                      : prev,
                  ),
              },
              dayData.preferred === 'dream' ? '看 journal' : '看 Dream',
            ),
          )
        }
        body.push(...renderMarkdown(dayDoc.body))
      }

      return h(
        'div',
        { className: 'wr-shell' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'wr-scroll' },
          h(
            'div',
            { className: 'wr-inner' },
            h(
              'header',
              { className: 'wr-header' },
              h(
                'div',
                { className: 'wr-heading' },
                h('h1', { className: 'wr-title' }, '工作回顾'),
                h(
                  'p',
                  { className: 'wr-sub' },
                  h('span', {}, '按周汇总 Dream 与 journal · 只读'),
                  h('span', { className: 'wr-sep' }, '·'),
                  h('span', { className: 'wr-mono' }, vaultLabel),
                  h('span', { className: 'wr-sep' }, '·'),
                  h('span', {}, `Work Review ${PANEL_VERSION}`),
                ),
              ),
              h('div', { className: 'wr-actions' }, ...headerActions),
            ),
            h(
              'div',
              { className: 'wr-toolbar' },
              h(
                'div',
                { className: 'wr-tabs' },
                h('button', { className: 'wr-tab', 'data-on': tab === 'day' ? '1' : '0', onClick: () => setTab('day') }, '日报'),
                h('button', { className: 'wr-tab', 'data-on': tab === 'week' ? '1' : '0', onClick: () => setTab('week') }, '周报'),
              ),
              h('span', { className: 'wr-grow' }),
              statusText ? h('span', { className: 'wr-status', 'data-kind': statusKind }, statusText) : null,
              h(
                'div',
                { className: 'wr-picker' },
                h('button', { className: 'wr-nav', 'aria-label': '更早', title: '更早', disabled: pickerIndex + 1 >= pickerList.length, onClick: () => step(1) }, '‹'),
                h(
                  'select',
                  {
                    className: 'wr-select',
                    'aria-label': tab === 'week' ? '选择周报' : '选择日报',
                    value: pickerValue,
                    onChange: (event) => select(event.target.value),
                    disabled: !pickerList.length,
                  },
                  ...options,
                ),
                h('button', { className: 'wr-nav', 'aria-label': '更新', title: '更新', disabled: pickerIndex <= 0, onClick: () => step(-1) }, '›'),
              ),
            ),
            h(
              'section',
              { className: 'wr-doc' },
              docTitle
                ? h(
                    'div',
                    { className: 'wr-doc-head' },
                    h(
                      'div',
                      { className: 'wr-doc-top' },
                      h('h2', { className: 'wr-doc-title' }, docTitle),
                      tab === 'day' && (approve || review) && dayDoc && dayDoc.body.trim()
                        ? h(
                            'div',
                            { className: 'wr-review' },
                            approve
                              ? h(
                                  'button',
                                  {
                                    className: 'wr-btn wr-btn-primary',
                                    title: approveBusy
                                      ? '自动审批正在后台运行；结束后面板会刷新并显示退出码'
                                      : '在 vault 里后台执行审批脚本（默认 scripts/dsh-run-task.py review <date> --live）',
                                    disabled: Boolean(approveBusy),
                                    onClick: startApprove,
                                  },
                                  approveBusy ? '运行中…' : approve.label || '执行自动审批',
                                )
                              : null,
                            review
                              ? h(
                                  'button',
                                  {
                                    className: 'wr-btn',
                                    title: review.autoSend
                                      ? `新建会话并直接发送：${review.command}`
                                      : `新建会话并预填草案（不自动发送）：${review.command}`,
                                    onClick: startReview,
                                  },
                                  review.label || '去审批',
                                )
                              : null,
                            approve && approveStatusLabel(approveState)
                              ? h(
                                  'span',
                                  {
                                    className: 'wr-review-note',
                                    'data-kind': approveKind,
                                    title: (approveState && (approveState.tail || approveState.error)) || '',
                                  },
                                  approveStatusLabel(approveState),
                                )
                              : null,
                          )
                        : null,
                    ),
                    chips.length ? h('div', { className: 'wr-chips' }, ...chips) : null,
                  )
                : null,
              h('div', { className: 'wr-prose' }, ...body),
            ),
            h(
              'footer',
              { className: 'wr-foot' },
              h('span', {}, '只读面板 · 数据留在本机'),
              h('span', {}, '·'),
              h('span', { className: 'wr-mono' }, `vault: ${vaultLabel}`),
              index && index.today ? h('span', {}, `· 今天 ${index.today}`) : null,
              h('span', {}, '·'),
              h('span', {}, `Work Review ${PANEL_VERSION}`),
            ),
          ),
        ),
      )
    }

    return {
      inject: ['slots', 'layout'],
      apply(ctx) {
        ctx.effect(
          () =>
            ctx.slots.inject('main', () =>
              ctx.slots.register(
                {
                  name: 'main',
                  key: PANEL_ID,
                  inject: () => ({
                    layout: ctx.layout,
                    // 可选服务：惰性取用，缺失时面板降级（不硬注入，避免旧版 Harness 起不来）
                    services: {
                      uiWorkspace: () => ctx.get('uiWorkspace'),
                      sessions: () => ctx.get('sessions'),
                    },
                  }),
                },
                RoutineView,
              ),
            ),
          'work-review: routine main panel',
        )
        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.panellist', () =>
              ctx.slots.register(
                {
                  name: 'sidebar.panellist',
                  id: PANEL_ID,
                  // 排在「自动化任务」（ui-schedule，order 10）下方
                  order: 20,
                  label: () => '工作回顾',
                },
                RoutineIcon,
              ),
            ),
          'work-review: sidebar entry',
        )
      },
    }
  },
})
