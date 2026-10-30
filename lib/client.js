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
    const PANEL_VERSION = '0.3.0'

    // ---------------------------------------------------------------------
    // 样式（只用 --dsw-alias-* token；整块由组件渲染，卸载即消失）
    // ---------------------------------------------------------------------
    const CSS = `
.sr-root{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px}
.sr-root:not([data-sized]) .sr-head,.sr-root:not([data-sized]) .sr-side{position:sticky;z-index:2}
.sr-root:not([data-sized]) .sr-head{top:0}
.sr-root:not([data-sized]) .sr-side{top:44px;align-self:flex-start;max-height:calc(100vh - 120px)}
.sr-head{display:flex;align-items:center;gap:8px;padding:8px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);flex:0 0 auto}
.sr-tabs{display:flex;gap:2px;background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:2px}
.sr-tab{border:0;background:transparent;color:var(--dsw-alias-label-secondary);padding:4px 12px;border-radius:6px;cursor:pointer;font-size:12px;font-family:inherit}
.sr-tab[data-on="1"]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.08)}
.sr-spacer{flex:1}
.sr-btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px;font-family:inherit;white-space:nowrap}
.sr-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.sr-btn[disabled]{opacity:.45;cursor:not-allowed}
.sr-btn.sr-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.sr-main{display:flex;flex:1;min-height:0;overflow:hidden}
.sr-side{width:150px;flex:0 0 auto;overflow:auto;overscroll-behavior:contain;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);padding:6px}
.sr-item{display:flex;flex-direction:column;gap:2px;padding:6px 8px;border-radius:6px;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary)}
.sr-item:hover{background:var(--dsw-alias-bg-layer-2)}
.sr-item[data-on="1"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600}
.sr-item small{font-size:10px;color:var(--dsw-alias-state-idle-primary)}
.sr-empty{color:var(--dsw-alias-label-secondary);font-size:12px;padding:10px}
.sr-body{flex:1;overflow:auto;overscroll-behavior:contain;padding:16px 20px 40px;min-width:0}
.sr-foot{flex:0 0 auto;padding:6px 14px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-secondary);display:flex;gap:10px;align-items:center;min-height:26px}
.sr-foot .sr-msg{color:var(--dsw-alias-state-success-primary)}
.sr-foot .sr-warn{color:var(--dsw-alias-state-warn-primary)}
.sr-foot .sr-err{color:var(--dsw-alias-state-error-primary)}
.sr-h1{font-size:17px;font-weight:650;margin:4px 0 10px}
.sr-h2{font-size:14px;font-weight:650;margin:18px 0 8px;padding-bottom:4px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.sr-h3{font-size:13px;font-weight:650;margin:14px 0 6px;color:var(--dsw-alias-brand-primary)}
.sr-h4{font-size:12px;font-weight:650;margin:10px 0 4px}
.sr-p{margin:6px 0;line-height:1.65}
.sr-ul{margin:6px 0;padding-left:18px}
.sr-ul li{margin:3px 0;line-height:1.6}
.sr-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;background:var(--dsw-alias-bg-layer-2);border-radius:4px;padding:1px 4px}
.sr-pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px;overflow:auto;margin:8px 0;white-space:pre-wrap}
.sr-quote{border-left:3px solid var(--dsw-alias-border-l2);padding:2px 10px;color:var(--dsw-alias-label-secondary);margin:8px 0}
.sr-link{color:var(--dsw-alias-brand-primary);border-bottom:1px dashed var(--dsw-alias-border-l2)}
.sr-meta{font-size:11px;color:var(--dsw-alias-label-secondary);margin:0 0 10px}
.sr-badge{display:inline-block;font-size:10px;padding:1px 6px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);margin-left:6px}
`

    // ---------------------------------------------------------------------
    // 工具
    // ---------------------------------------------------------------------
    function fetchJson(path) {
      return fetch(API + path, { headers: { accept: 'application/json' } }).then((r) => r.json())
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
          nodes.push(h('code', { key, className: 'sr-code' }, token.slice(1, -1)))
        } else if (token.startsWith('[[')) {
          const inner = token.slice(2, -2)
          const label = inner.includes('|') ? inner.split('|').pop() : inner.split('/').pop()
          nodes.push(h('span', { key, className: 'sr-link', title: inner }, label))
        } else {
          nodes.push(h('code', { key, className: 'sr-code' }, token.slice(1, -1)))
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
        if (!line.trim() || /^<!--/.test(line)) {
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
          out.push(h('pre', { key: `pre${key++}`, className: 'sr-pre' }, buf.join('\n')))
          continue
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading) {
          const level = Math.min(heading[1].length, 4)
          out.push(
            h(`div`, { key: `h${key++}`, className: `sr-h${level}` }, renderInline(heading[2], `h${key}`)),
          )
          i += 1
          continue
        }
        if (/^\s*[-*]\s+/.test(line)) {
          const items = []
          while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
            items.push(
              h('li', { key: `li${key++}` }, renderInline(lines[i].replace(/^\s*[-*]\s+/, ''), `l${key}`)),
            )
            i += 1
          }
          out.push(h('ul', { key: `ul${key++}`, className: 'sr-ul' }, items))
          continue
        }
        if (/^>\s?/.test(line)) {
          const buf = []
          while (i < lines.length && /^>\s?/.test(lines[i])) {
            buf.push(lines[i].replace(/^>\s?/, ''))
            i += 1
          }
          out.push(h('div', { key: `q${key++}`, className: 'sr-quote' }, renderInline(buf.join(' '), `q${key}`)))
          continue
        }
        if (/^---+$/.test(line.trim())) {
          out.push(h('div', { key: `hr${key++}`, style: { borderTop: '1px solid var(--dsw-alias-border-l1)', margin: '12px 0' } }))
          i += 1
          continue
        }
        const para = [line]
        i += 1
        while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
          para.push(lines[i])
          i += 1
        }
        out.push(h('p', { key: `p${key++}`, className: 'sr-p' }, renderInline(para.join(' '), `p${key}`)))
      }
      return out
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

    /**
     * 让面板占满「滚动视口」而不是让外层滚动整页。
     * 为什么需要：conversation 的 viewArea 在 active 阶段是 flex:1 0 auto; min-height:auto，
     * 高度随内容长，滚动发生在祖先 .scrollBody(overflow-y:auto) 上，纯 CSS 百分比高度不生效。
     * 做法：向上找 overflow-y auto/scroll 的节点，把它的可视高度换算成像素钉在本面板上；
     * 拿不到就退回 CSS sticky（头栏吸顶、侧栏吸附），不至于不可用。
     */
    function findScrollParent(el) {
      let node = el && el.parentElement
      while (node) {
        const style = window.getComputedStyle(node)
        if (/(auto|scroll)/.test(style.overflowY) && node.clientHeight > 0) return node
        node = node.parentElement
      }
      return null
    }

    function useFillHeight(ref) {
      React.useEffect(() => {
        const el = ref.current
        if (!el) return undefined
        const scroller = findScrollParent(el)
        if (!scroller) return undefined
        const apply = () => {
          const box = scroller.getBoundingClientRect()
          const top = Math.max(box.top, el.getBoundingClientRect().top)
          const free = Math.floor(box.bottom - top)
          if (free > 120) {
            el.style.height = `${free}px`
            el.setAttribute('data-sized', '1')
          }
        }
        apply()
        let raf = 0
        const schedule = () => {
          cancelAnimationFrame(raf)
          raf = requestAnimationFrame(apply)
        }
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null
        if (observer) observer.observe(scroller)
        window.addEventListener('resize', schedule)
        return () => {
          cancelAnimationFrame(raf)
          if (observer) observer.disconnect()
          window.removeEventListener('resize', schedule)
          el.style.height = ''
          el.removeAttribute('data-sized')
        }
      }, [ref])
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
      const rootRef = React.useRef(null)
      useFillHeight(rootRef)
      // 默认日报：日报频率更高（设计默认是周报，实测日报更常用）
      const [tab, setTab] = React.useState('day')
      const [index, setIndex] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [week, setWeek] = React.useState('')
      const [routine, setRoutine] = React.useState(null)
      const [date, setDate] = React.useState('')
      const [dayData, setDayData] = React.useState(null)
      const { status, insert, say } = useInsertion()

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

      const weekBody = routine && routine.ok ? routine.body : ''
      const weekQuote = routine && routine.ok ? routine.quote || weekBody.slice(0, 1200) : ''

      const dayPreferred = dayData && dayData.ok ? dayData.preferred : null
      const dayMarkdown =
        dayData && dayData.ok && dayData[dayPreferred] ? dayData[dayPreferred].markdown : ''
      const dayInsertText = dayData && dayData.ok ? dayQuote(dayMarkdown, dayData.date) : ''

      const copy = (text) => {
        if (!text) return say('warn', '没有可复制的内容')
        const ok = copyToClipboard(text)
        say(ok ? 'ok' : 'err', ok ? `已复制 ${text.length} 字符` : '复制失败（浏览器未授权剪贴板）')
      }

      const layout = props && props.layout ? props.layout : null
      const headerActions = []
      if (layout && typeof layout.selectPanel === 'function') {
        headerActions.push(
          h(
            'button',
            {
              key: 'back',
              className: 'sr-btn',
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
            className: 'sr-btn sr-primary',
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
            className: 'sr-btn',
            title: '复制当前内容',
            onClick: () => {
              copy(tab === 'week' ? (routine && routine.ok ? routine.markdown : '') : dayMarkdown)
            },
          },
          '复制',
        ),
      )
      headerActions.push(
        h(
          'button',
          {
            key: 'reload',
            className: 'sr-btn',
            title: '重新读取（面板只读，不触发生成）',
            onClick: () => {
              if (tab === 'week') loadWeek(week)
              else loadDay(date)
            },
          },
          '刷新',
        ),
      )

      const sideItems =
        tab === 'week'
          ? weeks.map((r) =>
              h(
                'div',
                {
                  key: r.week,
                  className: 'sr-item',
                  'data-on': r.week === week ? '1' : '0',
                  onClick: () => loadWeek(r.week),
                },
                h('span', {}, r.week),
                h('small', {}, `${formatRange(r.start, r.end)}${r.status ? ` · ${r.status}` : ''}`),
              ),
            )
          : days.slice(0, 60).map((d) =>
              h(
                'div',
                {
                  key: d.date,
                  className: 'sr-item',
                  'data-on': d.date === date ? '1' : '0',
                  onClick: () => loadDay(d.date),
                },
                h('span', {}, d.date),
                h(
                  'small',
                  {},
                  [d.dream ? 'Dream' : '', d.journal ? 'journal' : ''].filter(Boolean).join(' / ') || '无数据',
                ),
              ),
            )

      const emptySide =
        (tab === 'week' && !weeks.length) || (tab === 'day' && !days.length)
          ? h('div', { className: 'sr-empty' }, tab === 'week' ? '还没有周报文件' : '暂无日报')
          : null

      const body = []
      if (tab === 'week') {
        if (!weekBody) {
          body.push(
            h(
              'div',
              { key: 'none', className: 'sr-empty' },
              routine && routine.error
                ? `读取失败：${routine.error}`
                : '这一周还没有周报。生成用：node lib/cli.js --week ' + (week || '<YYYY-Www>'),
            ),
          )
        } else {
          body.push(
            h(
              'div',
              { key: 'meta', className: 'sr-meta' },
              `${week} · ${formatRange(routine.start, routine.end)}`,
              routine.status ? h('span', { className: 'sr-badge' }, routine.status) : null,
              h('span', { className: 'sr-badge' }, routine.path || ''),
            ),
          )
          body.push(...renderMarkdown(weekBody))
        }
      } else if (!dayMarkdown) {
        body.push(
          h(
            'div',
            { key: 'none', className: 'sr-empty' },
            dayData && dayData.error ? `读取失败：${dayData.error}` : '这一天没有 Dream 或 journal',
          ),
        )
      } else {
        const preferred = dayData[dayPreferred]
        body.push(
          h(
            'div',
            { key: 'meta', className: 'sr-meta' },
            `${dayData.date} · ${dayPreferred === 'dream' ? 'Dream 早报' : 'journal'}`,
            h('span', { className: 'sr-badge' }, preferred.path || ''),
            dayData.dream && dayData.journal
              ? h(
                  'button',
                  {
                    className: 'sr-btn',
                    style: { marginLeft: 8 },
                    onClick: () =>
                      setDayData((prev) =>
                        prev && prev.ok
                          ? { ...prev, preferred: prev.preferred === 'dream' ? 'journal' : 'dream' }
                          : prev,
                      ),
                  },
                  dayData.preferred === 'dream' ? '看 journal' : '看 Dream',
                )
              : null,
          ),
          ...renderMarkdown(dayMarkdown),
        )
      }

      return h(
        'div',
        { className: 'sr-root', ref: rootRef },
        h('style', null, CSS),
        h(
          'div',
          { className: 'sr-head' },
          h(
            'div',
            { className: 'sr-tabs' },
            h(
              'button',
              { className: 'sr-tab', 'data-on': tab === 'day' ? '1' : '0', onClick: () => setTab('day') },
              '日报',
            ),
            h(
              'button',
              { className: 'sr-tab', 'data-on': tab === 'week' ? '1' : '0', onClick: () => setTab('week') },
              '周报',
            ),
          ),
          h('span', { className: 'sr-spacer' }),
          ...headerActions,
        ),
        h(
          'div',
          { className: 'sr-main' },
          h('div', { className: 'sr-side' }, emptySide, ...sideItems),
          h('div', { className: 'sr-body' }, ...body),
        ),
        h(
          'div',
          { className: 'sr-foot' },
          error
            ? h('span', { className: 'sr-err' }, `错误：${error}`)
            : h('span', {}, index ? `vault: ${index.vault} · 今日 ${index.today} · panel ${PANEL_VERSION}` : '加载中…'),
          busy ? h('span', {}, '读取中…') : null,
          status
            ? h('span', { className: status.kind === 'ok' ? 'sr-msg' : status.kind === 'err' ? 'sr-err' : 'sr-warn' }, status.text)
            : null,
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
                  inject: () => ({ layout: ctx.layout }),
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
