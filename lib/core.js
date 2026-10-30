/**
 * core.js — 工作回顾（Work Review）的纯数据层（不依赖 DSH）。
 *
 * 职责：
 *   1. 日期发现（ISO 周、7 天、缺失日）
 *   2. 读取 life/dreams、life/journal、life/notes/ingest、life/tasks、git log（只读）
 *   3. 抽取 facts pack（JSON，给 LLM 与面板共用）
 *   4. 渲染确定性章节（趋势 / 数据口径）与整文件（frontmatter + 幂等块）
 *
 * 这里不写任何 LLM 逻辑；prompt.js 负责 facts → prompt 与输出校验。
 * 所有函数都是「输入 → 输出」，除显式的 writeRoutineFile() 外不产生副作用。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, relative, resolve, sep } from 'node:path'

import { resolveVaultRoot, vaultHint } from './config.js'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 生成块起点标记（与旧版文件兼容的 marker）。 */
export const GENERATED_MARKER = '<!-- sleep-routine:generated -->'
/** 生成块终点标记；标记之后是手写区，重跑不覆盖。 */
export const GENERATED_END_MARKER = '<!-- sleep-routine:generated:end -->'
/** facts 哈希锚点；同哈希重跑跳过 LLM，保证幂等。 */
export const HASH_PREFIX = '<!-- sleep-routine:facts-hash:'

export const REL = {
  dreams: 'life/dreams',
  journal: 'life/journal',
  ingest: 'life/notes/ingest',
  tasks: 'life/tasks',
  routines: 'life/routines',
}

/** 解析 frontmatter 用不到完整 YAML，只支持本 vault 的写法。 */
const WEEKDAY_CN = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

/**
 * vault 根目录：显式参数 > $DSH_WORK_REVIEW_VAULT > ~/.dsh/work-review.json 的 vaultRoot。
 * 都没配置时返回空串（不猜默认路径）；具体见 config.js。
 */
export { resolveVaultRoot }

/** 本地时区的 YYYY-MM-DD（不要用 toISOString，会被 UTC 拉偏一天）。 */
export function todayLocal(now = new Date()) {
  const options = { year: 'numeric', month: '2-digit', day: '2-digit' }
  // 不写死时区：TZ 显式设置时用它，否则用运行机器的本地时区。
  if (process.env.TZ) options.timeZone = process.env.TZ
  return new Intl.DateTimeFormat('en-CA', options).format(now)
}

function utcDate(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

function fmtUTC(date) {
  return date.toISOString().slice(0, 10)
}

/** dateStr → {year, week, weekStr}（ISO 8601，周一为第一天）。 */
export function isoWeekOf(dateStr) {
  const d = utcDate(dateStr)
  const dayNum = (d.getUTCDay() + 6) % 7 // 周一=0
  const thursday = new Date(d)
  thursday.setUTCDate(d.getUTCDate() - dayNum + 3)
  const year = thursday.getUTCFullYear()
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const jan4DayNum = (jan4.getUTCDay() + 6) % 7
  const firstMonday = new Date(jan4)
  firstMonday.setUTCDate(jan4.getUTCDate() - jan4DayNum)
  const week = Math.round((thursday - firstMonday) / (7 * 86400000)) + 1
  return { year, week, weekStr: `${year}-W${String(week).padStart(2, '0')}` }
}

/** "YYYY-Www" → 周一日期。 */
export function weekStart(weekStr) {
  const m = /^(\d{4})-W(\d{1,2})$/.exec(String(weekStr))
  if (!m) throw new Error(`不是合法的 ISO 周: ${weekStr}（应为 YYYY-Www）`)
  const year = Number(m[1])
  const week = Number(m[2])
  if (week < 1 || week > 53) throw new Error(`周号越界: ${weekStr}`)
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const jan4DayNum = (jan4.getUTCDay() + 6) % 7
  const firstMonday = new Date(jan4)
  firstMonday.setUTCDate(jan4.getUTCDate() - jan4DayNum)
  const monday = new Date(firstMonday.getTime() + (week - 1) * 7 * 86400000)
  return fmtUTC(monday)
}

/** "YYYY-Www" → {weekStr, start, end, dates[7]}。 */
export function weekRange(weekStr) {
  const start = weekStart(weekStr)
  const dates = []
  for (let i = 0; i < 7; i += 1) {
    const d = utcDate(start)
    d.setUTCDate(d.getUTCDate() + i)
    dates.push(fmtUTC(d))
  }
  return { weekStr, start: dates[0], end: dates[6], dates }
}

/**
 * 周规格 → weekStr。支持 last / current / 2026-W44 / 偏移（-2）。
 * last  = 上一个完整周（周日已过），current = 今天所在周。
 */
export function resolveWeekSpec(spec, today = todayLocal()) {
  const raw = String(spec ?? 'last').trim()
  if (/^\d{4}-W\d{1,2}$/.test(raw)) return raw
  const { weekStr } = isoWeekOf(today)
  if (raw === 'current' || raw === 'this') return weekStr
  if (raw === 'last') {
    // 周日 20:00 定时跑：本周（周日）刚好收尾 → 汇总本周；
    // 其他日子手动补跑：上一个完整周。
    return weekdayOf(today) === 7 ? weekStr : previousWeek(weekStr)
  }
  const offset = Number(raw)
  if (Number.isFinite(offset)) {
    const monday = weekStart(weekStr)
    const d = utcDate(monday)
    d.setUTCDate(d.getUTCDate() + offset * 7)
    return isoWeekOf(fmtUTC(d)).weekStr
  }
  throw new Error(`无法识别的 --week 值: ${raw}（用 last / current / 2026-W44 / -1）`)
}

/** 上一周的 weekStr。 */
export function previousWeek(weekStr) {
  const monday = weekStart(weekStr)
  const d = utcDate(monday)
  d.setUTCDate(d.getUTCDate() - 7)
  return isoWeekOf(fmtUTC(d)).weekStr
}

/** 星期几（1=周一）。 */
export function weekdayOf(dateStr) {
  return ((utcDate(dateStr).getUTCDay() + 6) % 7) + 1
}

export function weekdayLabel(dateStr) {
  return WEEKDAY_CN[weekdayOf(dateStr) - 1]
}

/** 10-27 这种短日期，用于引用。 */
export function shortDate(dateStr) {
  return String(dateStr).slice(5)
}

export function relPath(from, abs) {
  return relative(from, abs).split(sep).join('/')
}

function safeRead(absPath) {
  try {
    if (!existsSync(absPath) || !statSync(absPath).isFile()) return null
    return readFileSync(absPath, 'utf8')
  } catch {
    return null
  }
}

function listMarkdown(dirAbs) {
  try {
    if (!existsSync(dirAbs)) return []
    return readdirSync(dirAbs)
      .filter((n) => n.endsWith('.md') && !n.startsWith('_'))
      .sort()
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// frontmatter / heading / bullet 解析
// ---------------------------------------------------------------------------

function stripQuotes(v) {
  const s = String(v).trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1)
  }
  return s
}

/** 只解析本 vault 实际用到的 YAML 子集：标量 + 短列表。 */
export function parseFrontmatter(text) {
  const src = String(text ?? '')
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(src)
  if (!m) return { data: {}, body: src, raw: '' }
  const data = {}
  let currentKey = null
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item && currentKey) {
      if (!Array.isArray(data[currentKey])) data[currentKey] = []
      data[currentKey].push(stripQuotes(item[1]))
      continue
    }
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!kv) continue
    currentKey = kv[1]
    const value = kv[2].trim()
    data[currentKey] = value === '' ? [] : stripQuotes(value)
  }
  return { data, body: src.slice(m[0].length), raw: m[1] }
}

/** 按指定层级标题切段：[{level, title, body}]（title 不含 #）。 */
export function splitByHeading(markdown, level) {
  const src = String(markdown ?? '')
  const lines = src.split(/\r?\n/)
  const want = '#'.repeat(level)
  const out = []
  let current = null
  const buffer = []
  const flush = () => {
    if (current) {
      current.body = buffer.join('\n').trim()
      out.push(current)
      buffer.length = 0
    }
  }
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence
    const isHeading = !inFence && new RegExp(`^${want} (.*)$`).test(line)
    if (isHeading) {
      flush()
      current = { level, title: line.slice(level + 1).trim(), body: '' }
      continue
    }
    if (current) buffer.push(line)
  }
  flush()
  return out
}

/** 取某个 level-2 章节内容（按关键字包含匹配）。 */
export function section(markdown, keyword, level = 2) {
  const found = splitByHeading(markdown, level).find((s) => s.title.includes(keyword))
  return found ? found.body : ''
}

/** 取 HTML 注释块之间的内容。 */
export function between(markdown, begin, end) {
  const src = String(markdown ?? '')
  const start = src.indexOf(begin)
  if (start < 0) return null
  const from = start + begin.length
  const stop = src.indexOf(end, from)
  return src.slice(from, stop < 0 ? src.length : stop).trim()
}

/** 列表项 → [{key, value, sub:[]}]。支持 `- 键：值` 与缩进续行。 */
export function parseFieldBullets(markdown) {
  const out = []
  let current = null
  for (const raw of String(markdown ?? '').split(/\r?\n/)) {
    const top = /^\s*-\s+(.*)$/.exec(raw)
    const isIndented = /^\s{2,}\S/.test(raw)
    if (top && !isIndented) {
      const content = top[1].trim()
      const sep = /^(.*?)[：:]\s*(.*)$/.exec(content)
      current = sep
        ? { key: sep[1].trim(), value: sep[2].trim(), sub: [] }
        : { key: null, value: content, sub: [] }
      out.push(current)
      continue
    }
    if (isIndented && current && raw.trim()) current.sub.push(raw.trim())
  }
  return out
}

/** 去掉满足条件的某一层标题块（标题行到下一个同级/更高级标题前）。 */
export function withoutHeadingBlocks(markdown, level, predicate) {
  const lines = String(markdown ?? '').split(/\r?\n/)
  const out = []
  let skip = false
  const re = /^(#{1,6})\s+(.*)$/
  for (const line of lines) {
    const m = re.exec(line)
    if (m) {
      const depth = m[1].length
      if (depth === level && predicate(m[2].trim())) {
        skip = true
        continue
      }
      if (skip && depth <= level) skip = false
    }
    if (!skip) out.push(line)
  }
  return out.join('\n')
}

/** 字段列表 → {键: 值}；续行以 \n 拼回。 */
export function fieldsOf(markdown) {
  const fields = {}
  for (const item of parseFieldBullets(markdown)) {
    if (!item.key) continue
    fields[item.key] = item.sub.length ? [item.value, ...item.sub].join('\n') : item.value
  }
  return fields
}

/** 列表项纯文本（不含键）。 */
export function bulletsOf(markdown) {
  return String(markdown ?? '')
    .split(/\r?\n/)
    .map((l) => /^\s*-\s+(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => m[1].trim())
    .filter(Boolean)
}

function pick(fields, ...keys) {
  for (const k of keys) {
    if (fields[k] != null && fields[k] !== '') return fields[k]
  }
  return ''
}

// ---------------------------------------------------------------------------
// Dream / journal / ingest 抽取
// ---------------------------------------------------------------------------

/** 解析 life/dreams/<date>.md。 */
export function parseDream(markdown) {
  const { data: fm, body } = parseFrontmatter(markdown)
  const title = /^#\s+(.*)$/m.exec(body)?.[1]?.trim() ?? ''
  const yesterday = section(body, '昨日总结', 2)
  const itemSections = splitByHeading(yesterday, 3)

  const plans = []
  const collectPlans = (blocks) => {
    for (const block of blocks) {
      if (!/Task 更新计划|新任务建议/.test(block.title)) continue
      const idMatch = /·\s*([TG]\d+)/.exec(block.title)
      const fields = fieldsOf(block.body)
      plans.push({
        id: idMatch ? idMatch[1] : '',
        kind: /新任务建议/.test(block.title) ? 'new-task' : 'task-update',
        title: block.title.replace(/^[^·]*·\s*/, '').trim(),
        file: pick(fields, '文件'),
        current: pick(fields, '当前'),
        suggestion: pick(fields, '建议'),
        progress: pick(fields, '拟追加进度'),
        basis: pick(fields, '依据'),
        approval: pick(fields, '自动批准'),
        area: pick(fields, 'area'),
        initialStatus: pick(fields, '初始状态'),
        detail: pick(fields, '详情'),
      })
    }
  }
  // 4 级标题是「Task 更新计划 / 新任务建议」，全局扫一遍即可（它们是 item 的子块）
  collectPlans(splitByHeading(yesterday, 4))

  const items = itemSections.map((sec) => {
    const fields = fieldsOf(
      withoutHeadingBlocks(sec.body, 4, (t) => /Task 更新计划|新任务建议/.test(t)),
    )
    return {
      title: sec.title,
      result: pick(fields, '结果'),
      basis: pick(fields, '依据', '依据／出处'),
      next: pick(fields, '边界／下一步', '边界/下一步', '下一步'),
    }
  })

  const gitPlan = splitByHeading(section(body, 'Git commit plan', 2), 3).map((sec) => {
    const fields = fieldsOf(sec.body)
    const idMatch = /^\s*([G]\d+)/.exec(sec.title)
    return {
      id: idMatch ? idMatch[1] : '',
      title: sec.title.replace(/^\s*[G]\d+\s*·?\s*/, '').trim(),
      repo: pick(fields, '仓库'),
      outcomes: pick(fields, '对应成果'),
      include: pick(fields, '纳入'),
      exclude: pick(fields, '不纳入'),
      message: pick(fields, 'commit message'),
      precondition: pick(fields, '前置条件'),
      approval: pick(fields, '自动批准'),
    }
  })

  const focus = splitByHeading(section(body, '今日重点任务', 2), 3).map((sec) => {
    const fields = fieldsOf(sec.body)
    const numMatch = /^\s*(\d+)[.、]/.exec(sec.title)
    return {
      n: numMatch ? Number(numMatch[1]) : null,
      title: sec.title.replace(/^\s*\d+[.、]\s*/, '').trim(),
      ref: pick(fields, '对应'),
      reason: pick(fields, '优先理由'),
      firstStep: pick(fields, '今天第一步'),
      done: pick(fields, '算有进展'),
    }
  })

  const ingestMention =
    /入库候选：(.+)/.exec(yesterday)?.[1]?.trim() ?? /入库候选：(.+)/.exec(body)?.[1]?.trim() ?? ''

  return {
    title,
    created: fm.created ?? '',
    updated: fm.updated ?? '',
    tags: Array.isArray(fm.tags) ? fm.tags : [],
    summary: yesterday.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#')) ?? '',
    items,
    taskPlans: plans,
    gitPlans: gitPlan,
    focus,
    ingestMention,
    sections: splitByHeading(body, 2).map((s) => s.title),
  }
}

/** 解析审批块（<!-- sleep-review:begin --> …）里的 T/G 条目。 */
export function parseReviewBlock(markdown) {
  const entries = []
  if (!markdown) return { entries, done: [], pending: [] }
  let current = null
  for (const raw of String(markdown).split(/\r?\n/)) {
    const bullet = /^\s*-\s+(.*)$/.exec(raw)
    if (bullet) {
      const text = bullet[1].trim()
      const ids = [...text.matchAll(/\b([TG]\d+)\b/g)].map((m) => m[1])
      const sha = /提交：`([0-9a-f]{7,40})`/.exec(text)?.[1] ?? ''
      const executed = /执行：/.test(text) && !/未追加/.test(text)
      current = {
        time: /^(\d{4}-\d{2}-\d{2}[ T][\d:]+)/.exec(text)?.[1] ?? '',
        ids: [...new Set(ids)],
        verdict: /审查通过/.test(text) ? 'approved' : /未通过|驳回/.test(text) ? 'rejected' : 'unknown',
        escalated: /升级（/.test(text) || /·\s*升级/.test(text),
        executed,
        skipped: /未追加/.test(text),
        sha,
        text,
      }
      entries.push(current)
      continue
    }
    if (current && /^\s{2,}\S/.test(raw)) current.text += '\n' + raw.trim()
  }
  const done = []
  const pending = []
  for (const e of entries) {
    for (const id of e.ids) {
      if (e.sha || e.executed) done.push(id)
      else pending.push(id)
    }
  }
  return { entries, done: [...new Set(done)], pending: [...new Set(pending)] }
}

/** 解析 life/journal/<date>.md。 */
export function parseJournal(markdown) {
  const { data: fm, body } = parseFrontmatter(markdown)
  const sleepBlock = between(body, '<!-- sleep:begin -->', '<!-- sleep:end -->')
  const reviewBlock = between(body, '<!-- sleep-review:begin -->', '<!-- sleep-review:end -->')
  const scope = sleepBlock ?? body
  const review = parseReviewBlock(reviewBlock)
  return {
    title: /^#\s+(.*)$/m.exec(body)?.[1]?.trim() ?? fm.title ?? '',
    created: fm.created ?? '',
    updated: fm.updated ?? '',
    hasSleepBlock: sleepBlock != null,
    stats: bulletsOf(section(scope, 'Stats', 3)),
    progress: bulletsOf(section(scope, 'Progress', 3)),
    blockers: bulletsOf(section(scope, 'Blockers', 3)),
    threads: bulletsOf(section(scope, 'Threads', 3)),
    selfCheck: bulletsOf(section(scope, '自检', 3)),
    review,
    sections: splitByHeading(scope, 3).map((s) => s.title),
  }
}

/** 解析 life/notes/ingest/<date>.md。 */
export function parseIngest(markdown) {
  if (!markdown) return null
  const { body } = parseFrontmatter(markdown)
  const lines = body.split(/\r?\n/)
  const writeBack = []
  for (const line of lines) {
    const m = /^\s*-\s+(I\d+)[:：]\s*(.+)$/.exec(line)
    if (m) writeBack.push({ id: m[1], result: m[2].trim() })
  }
  const proposals = /(\d+)\s*条/.exec(body)?.[1] ?? ''
  return {
    proposals: proposals ? Number(proposals) : null,
    writeBack,
    writtenBack: writeBack.length,
  }
}

// ---------------------------------------------------------------------------
// blocker 复发
// ---------------------------------------------------------------------------

/**
 * blocker 的归一化 key：去掉日期/编号/括号注释，取第一分句前 28 字。
 * 只用于「跨天是不是同一件事」的粗判，最终措辞由 LLM 决定。
 */
export function blockerKey(text) {
  let s = String(text ?? '')
    .replace(/^\s*-\s*/, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\d{4}-\d{2}-\d{2}/g, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .trim()
  s = s.split(/[，,。；;：:]/)[0].replace(/\s+/g, ' ').trim()
  if (s.length > 20) s = s.slice(0, 20)
  return s
}

/** 跨天归并 blocker：[{key, dates, count, samples}]，按 count 降序。 */
export function groupBlockers(dayFacts) {
  const map = new Map()
  for (const day of dayFacts) {
    for (const text of day.blockers ?? []) {
      const key = blockerKey(text)
      if (!key) continue
      if (!map.has(key)) map.set(key, { key, dates: [], samples: [] })
      const entry = map.get(key)
      entry.dates.push(day.date)
      entry.samples.push(text)
    }
  }
  return [...map.values()]
    .map((e) => ({ ...e, dates: [...new Set(e.dates)], count: new Set(e.dates).size }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
}

// ---------------------------------------------------------------------------
// git（只读）
// ---------------------------------------------------------------------------

function git(args, cwd) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    })
  } catch {
    return null
  }
}

/** 本周 commits：{by_day, commits:[{sha,date,msg}]}。仓库不可用时给出 gitAvailable:false。 */
export function collectGit(vaultRoot, start, end) {
  const probe = git(['rev-parse', '--is-inside-work-tree'], vaultRoot)
  if (probe == null || probe.trim() !== 'true') {
    return { available: false, by_day: {}, commits: [] }
  }
  const raw = git(
    ['log', '-n', '1000', '--date=short', '--pretty=format:%h%x09%ad%x09%s'],
    vaultRoot,
  )
  const commits = []
  if (raw) {
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue
      const [sha, date, msg] = line.split('\t')
      if (!date || date < start || date > end) continue
      commits.push({ sha, date, msg: msg ?? '' })
    }
  }
  const by_day = {}
  for (let i = 0; i < 7; i += 1) {
    const d = utcDate(start)
    d.setUTCDate(d.getUTCDate() + i)
    by_day[fmtUTC(d)] = 0
  }
  for (const c of commits) by_day[c.date] = (by_day[c.date] ?? 0) + 1
  return { available: true, by_day, commits }
}

/** 本周每个 commit 改了哪些文件 → [{sha, date, files}]（用于 touched tasks）。 */
export function collectGitFiles(vaultRoot, start, end) {
  const raw = git(
    ['log', '-n', '1000', '--date=short', '--pretty=format:%x01%h%x02%ad%x02%s', '--name-only'],
    vaultRoot,
  )
  if (!raw) return []
  const out = []
  let current = null
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('\u0001')) {
      const [sha, date, msg] = line.slice(1).split('\u0002')
      current = { sha, date, msg: msg ?? '', files: [] }
      if (date >= start && date <= end) out.push(current)
      else current = null
      continue
    }
    if (current && line.trim()) current.files.push(line.trim())
  }
  return out
}

/** 读取某文件在某 commit（或父提交）里的 status 字段。 */
function statusAtCommit(vaultRoot, rev, path) {
  const raw = git(['show', `${rev}:${path}`], vaultRoot)
  if (!raw) return null
  return parseFrontmatter(raw).data.status ?? null
}

/** 本周 task 状态变化（best-effort；失败就返回空，不编造）。 */
export function collectTaskStatusChanges(vaultRoot, gitFiles, tasksRelDir = REL.tasks) {
  const byPath = new Map()
  for (const commit of gitFiles) {
    for (const file of commit.files) {
      if (!file.startsWith(tasksRelDir + '/')) continue
      if (!byPath.has(file)) byPath.set(file, [])
      byPath.get(file).push(commit)
    }
  }
  const changes = []
  for (const [path, commits] of [...byPath.entries()].slice(0, 30)) {
    const first = commits[commits.length - 1] // git log 是新→旧
    const last = commits[0]
    const before = statusAtCommit(vaultRoot, `${first.sha}^`, path)
    const after = statusAtCommit(vaultRoot, last.sha, path)
    if (before && after && before !== after) {
      changes.push({
        task: path.replace(tasksRelDir + '/', '').replace(/\.md$/, ''),
        path,
        from: before,
        to: after,
        sha: last.sha,
      })
    }
  }
  return changes
}

/** 本周被 commit 触碰或 frontmatter.updated 落在本周的 task。 */
export function collectTasks(vaultRoot, start, end, gitFiles) {
  const dirAbs = join(vaultRoot, REL.tasks)
  const touched = new Map()
  for (const name of listMarkdown(dirAbs)) {
    const abs = join(dirAbs, name)
    const md = safeRead(abs)
    if (!md) continue
    const { data } = parseFrontmatter(md)
    const updated = String(data.updated ?? '')
    if (updated >= start && updated <= end) {
      touched.set(relPath(vaultRoot, abs), {
        task: name.replace(/\.md$/, ''),
        path: relPath(vaultRoot, abs),
        status: data.status ?? '',
        area: data.area ?? '',
        updated,
        source: 'frontmatter-updated',
      })
    }
  }
  for (const commit of gitFiles) {
    for (const file of commit.files) {
      if (!file.startsWith(REL.tasks + '/')) continue
      if (touched.has(file)) continue
      const abs = join(vaultRoot, file)
      const md = safeRead(abs)
      const data = md ? parseFrontmatter(md).data : {}
      touched.set(file, {
        task: file.replace(REL.tasks + '/', '').replace(/\.md$/, ''),
        path: file,
        status: data.status ?? '',
        area: data.area ?? '',
        updated: data.updated ?? '',
        source: 'git-touched',
      })
    }
  }
  return [...touched.values()]
}

// ---------------------------------------------------------------------------
// facts pack
// ---------------------------------------------------------------------------

/**
 * 扫一周，产出 facts pack（字段约定 + 少量派生统计）。
 * opts: {vaultRoot, week, today, withGit=true}
 */
export function buildFactsPack(opts = {}) {
  const vaultRoot = resolveVaultRoot(opts.vaultRoot)
  if (!vaultRoot) throw new Error(vaultHint())
  const weekStr = /^\d{4}-W\d{1,2}$/.test(String(opts.week ?? ''))
    ? opts.week
    : resolveWeekSpec(opts.week ?? 'last', opts.today)
  const range = weekRange(weekStr)
  const today = opts.today ?? todayLocal()
  const withGit = opts.withGit !== false

  const days = range.dates.map((date) => {
    const dreamAbs = join(vaultRoot, REL.dreams, `${date}.md`)
    const journalAbs = join(vaultRoot, REL.journal, `${date}.md`)
    const ingestAbs = join(vaultRoot, REL.ingest, `${date}.md`)
    const dreamMd = safeRead(dreamAbs)
    const journalMd = safeRead(journalAbs)
    const dream = dreamMd ? parseDream(dreamMd) : null
    const journal = journalMd ? parseJournal(journalMd) : null
    const ingest = parseIngest(safeRead(ingestAbs))
    return {
      date,
      weekday: weekdayOf(date),
      weekdayLabel: weekdayLabel(date),
      dream: dreamMd ? relPath(vaultRoot, dreamAbs) : null,
      journal: journalMd ? relPath(vaultRoot, journalAbs) : null,
      ingest: ingest ? relPath(vaultRoot, ingestAbs) : null,
      dreamSummary: dream?.summary ?? '',
      dreamTitle: dream?.title ?? '',
      items: dream?.items ?? [],
      taskPlans: dream?.taskPlans ?? [],
      gitPlans: dream?.gitPlans ?? [],
      focus: dream?.focus ?? [],
      progress: journal?.progress ?? [],
      blockers: journal?.blockers ?? [],
      threads: journal?.threads ?? [],
      selfCheck: journal?.selfCheck ?? [],
      stats: journal?.stats ?? [],
      review: journal?.review ?? { entries: [], done: [], pending: [] },
      ingestDetail: ingest,
      missing: { dream: !dreamMd, journal: !journalMd, ingest: !ingest },
      past: date <= today,
    }
  })

  const gaps = days.filter((d) => d.missing.journal && d.missing.dream).map((d) => d.date)
  const gapDetail = days
    .filter((d) => d.missing.journal && d.missing.dream)
    .map((d) => ({ date: d.date, past: d.past, today: d.date === today, future: d.date > today }))

  const git = withGit ? collectGit(vaultRoot, range.start, range.end) : { available: false, by_day: {}, commits: [] }
  const gitFiles = withGit ? collectGitFiles(vaultRoot, range.start, range.end) : []
  const tasks = withGit
    ? {
        touched: collectTasks(vaultRoot, range.start, range.end, gitFiles),
        status_changes: collectTaskStatusChanges(vaultRoot, gitFiles),
      }
    : { touched: [], status_changes: [] }

  const coverage = {
    days: 7,
    dream: days.filter((d) => !d.missing.dream).length,
    journal: days.filter((d) => !d.missing.journal).length,
    ingest: days.filter((d) => !d.missing.ingest).length,
    gaps: gaps.length,
    gapsPast: gapDetail.filter((g) => g.past && !g.today).length,
    gapsToday: gapDetail.filter((g) => g.today).length,
    gapsFuture: gapDetail.filter((g) => g.future).length,
  }

  const blockers = groupBlockers(days)
  const reviewLedger = {
    done: days.flatMap((d) => d.review.done),
    pending: days.flatMap((d) => d.review.pending),
  }

  return {
    week: weekStr,
    start: range.start,
    end: range.end,
    today,
    complete: range.end <= today,
    days,
    git,
    tasks,
    gaps,
    gapDetail,
    coverage,
    blockers,
    reviewLedger,
    sources: {
      dreams: REL.dreams,
      journal: REL.journal,
      ingest: REL.ingest,
      tasks: REL.tasks,
    },
  }
}

/** facts pack → 全部输入文本（词表用）。 */
export function factsText(facts) {
  const parts = []
  const push = (v) => {
    if (v == null) return
    if (Array.isArray(v)) {
      for (const item of v) push(item)
      return
    }
    if (typeof v === 'object') {
      for (const value of Object.values(v)) push(value)
      return
    }
    parts.push(String(v))
  }
  push(facts.days)
  push(facts.blockers)
  push(facts.tasks)
  push(facts.git)
  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// 渲染（确定性章节）
// ---------------------------------------------------------------------------

/**
 * 本周相关日期的 wikilink（有数据的那几天）。
 * 必须带路径：`[[2026-10-19]]` 在 life/dreams、life/journal、life/notes/ingest 之间是
 * 3 个同名文件，`check-links.py` 会判 AMBIGUOUS。路径限定后无歧义。
 */
export function relatedLinks(facts) {
  const lines = []
  for (const d of facts.days) {
    if (d.missing.journal && d.missing.dream) continue
    if (!d.missing.journal) lines.push(`  - "[[${REL.journal}/${d.date}|${d.date} 日记]]"`)
    if (!d.missing.dream) lines.push(`  - "[[${REL.dreams}/${d.date}|${d.date} Dream]]"`)
  }
  return lines
}

/**
 * 把正文里的裸日期 wikilink 改成路径限定（`[[2026-10-19]]` → `[[life/journal/2026-10-19|2026-10-19]]`）。
 * 目标按「journal ?? dreams ?? ingest」可用性选择；已带路径的链接不动。
 */
export function normalizeDateLinks(markdown, facts) {
  const byDate = new Map(facts.days.map((d) => [d.date, d]))
  return String(markdown ?? '').replace(
    /\[\[(\d{4}-\d{2}-\d{2})(?:\|([^\]]+))?\]\]/g,
    (whole, date, label) => {
      const day = byDate.get(date)
      if (!day) return whole
      const dir = !day.missing.journal ? REL.journal : !day.missing.dream ? REL.dreams : REL.ingest
      return `[[${dir}/${date}|${label || date}]]`
    },
  )
}

/** 整文件 frontmatter。所有字段都由周决定，重跑不变。 */
export function renderFrontmatter(facts) {
  const title = `Routine ${facts.week}（${facts.start} → ${facts.end}）`
  const status = facts.complete ? 'final' : 'draft'
  const lines = [
    '---',
    'type: routine',
    'domain: life',
    `title: "${title}"`,
    `created: ${facts.end}`,
    `updated: ${facts.end}`,
    `status: ${status}`,
    'tags:',
    '  - dream-report',
    '  - sleep',
    '  - routine',
    'related:',
    ...relatedLinks(facts),
    '---',
  ]
  return lines.join('\n')
}

/** 「趋势」章节。 */
export function renderTrend(facts) {
  const total = facts.git.commits.length
  const perDay = facts.days
    .map((d) => `${shortDate(d.date)}: ${facts.git.by_day?.[d.date] ?? 0}`)
    .join(' / ')
  const touched = facts.tasks.touched
  const shortName = (name) => (name.length > 14 ? `${name.slice(0, 14)}…` : name)
  const touchedText = touched.length
    ? `${touched.length}（${touched
        .slice(0, 4)
        .map((t) => shortName(t.task))
        .join('、')}${touched.length > 4 ? ' 等' : ''}）`
    : '0'
  const recurring = facts.blockers.filter((b) => b.count >= 2)
  const recurringText = recurring.length
    ? `${recurring.length} 条（${recurring
        .slice(0, 4)
        .map((b) => `${b.key}：${b.count} 天`)
        .join('；')}）`
    : '0 条'
  const lines = [
    '## 趋势',
    facts.git.available
      ? `- commits：${total}（${perDay}）`
      : '- commits：git 不可用，未采集',
    `- touched tasks：${touchedText}`,
    `- blocker 复发：${recurringText}`,
  ]
  if (facts.tasks.status_changes.length) {
    lines.push(
      `- task 状态变化：${facts.tasks.status_changes
        .slice(0, 8)
        .map((c) => `${c.task} ${c.from}→${c.to}`)
        .join('；')}`,
    )
  }
  return lines.join('\n')
}

/** 「数据口径」章节。 */
export function renderCoverage(facts) {
  const c = facts.coverage
  const gapText = facts.gapDetail.length
    ? facts.gapDetail
        .map((g) =>
          g.today ? `${shortDate(g.date)}(今日)` : g.future ? `${shortDate(g.date)}(未到)` : shortDate(g.date),
        )
        .join('、')
    : '无'
  const gapsNote = []
  if (c.gapsPast) gapsNote.push(`${c.gapsPast} 天已发生但无数据`)
  if (c.gapsToday) gapsNote.push(`${c.gapsToday} 天为今日、尚未产出`)
  if (c.gapsFuture) gapsNote.push(`${c.gapsFuture} 天在本周内尚未发生`)
  return [
    '## 数据口径',
    `- 覆盖：7 天（Dream ${c.dream} / journal ${c.journal} / ingest ${c.ingest}）；缺失：${gapText}` +
      (gapsNote.length ? `（${gapsNote.join('，')}）` : ''),
    `- 数据源：${facts.sources.dreams}/、${facts.sources.journal}/、${facts.sources.ingest}/、${facts.sources.tasks}/、git log（均为只读）`,
    '- 规则：缺失日不补写、不猜测；当天无 Dream 时回退 journal 的 Progress/Blockers/Threads。',
  ].join('\n')
}

/** 没有 LLM 时的确定性正文骨架（--no-llm 用，显式标注未经合成）。 */
export function renderDeterministicBody(facts) {
  // 注意：不写 H1 —— renderGeneratedBlock() 统一加 `# Routine <week>`。
  const lines = ['']
  lines.push('## 本周一句话', '', '> 未经 LLM 合成：本周事实见下，正式周报请重跑生成。', '')
  lines.push('## 进展（按项目 / 任务）', '')
  const seen = new Set()
  for (const day of facts.days) {
    for (const item of day.items) {
      if (!item.title || seen.has(item.title)) continue
      seen.add(item.title)
      lines.push(`### ${item.title}`)
      if (item.result) lines.push(`- 起因：${item.result}`)
      if (item.next) lines.push(`- 下一步：${item.next}`)
      lines.push(`- 依据：[[${day.date}]]`)
      lines.push('')
    }
  }
  if (!seen.size) lines.push('- 本周无 Dream 事项可抽取。', '')
  lines.push('## 反复出现的 blocker', '')
  const recurring = facts.blockers.filter((b) => b.count >= 2)
  if (recurring.length) {
    for (const b of recurring) {
      lines.push(`- ${b.key}：出现 ${b.count} 天（${b.dates.map(shortDate).join(' / ')}）`)
    }
  } else {
    lines.push('- 本周无跨天重复的 blocker。')
  }
  lines.push('')
  lines.push('## 未闭环', '')
  const pending = facts.days.flatMap((d) => d.review.pending.map((id) => `${d.date} ${id}`))
  if (pending.length) {
    for (const p of pending) lines.push(`- ${p}（未执行，见 [[${p.split(' ')[0]}]]）`)
  } else {
    lines.push('- 本周审批块无未执行条目。')
  }
  lines.push('')
  lines.push(renderTrend(facts), '')
  lines.push(renderCoverage(facts))
  return lines.join('\n').trim()
}

/** facts → 哈希输入（决定是否跳过 LLM）。 */
export function computeFactsHash(facts, extra = '') {
  const payload = JSON.stringify({
    week: facts.week,
    days: facts.days.map((d) => ({
      date: d.date,
      dream: d.dream,
      journal: d.journal,
      items: d.items.length,
      progress: d.progress.length,
      blockers: d.blockers.length,
      threads: d.threads.length,
    })),
    git: facts.git.commits.map((c) => c.sha),
    touched: facts.tasks.touched.map((t) => t.path),
    extra,
  })
  // 这是一个内容指纹，不是密码学用途；保持纯 JS 实现（node:crypto 也行）。
  let h1 = 0x811c9dc5
  let h2 = 0x1000193
  for (let i = 0; i < payload.length; i += 1) {
    const code = payload.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0
    h2 = Math.imul(h2 + code, 0x85ebca6b) >>> 0
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 16)
}

// ---------------------------------------------------------------------------
// 整文件组装 / 幂等读写
// ---------------------------------------------------------------------------

/** 组装生成块：marker + hash + 正文。 */
export function renderGeneratedBlock(facts, llmBody, hash) {
  const body = [GENERATED_MARKER, `${HASH_PREFIX} ${hash} -->`, `# Routine ${facts.week}`, '', llmBody.trim()]
  return body.join('\n').trimEnd() + '\n' + GENERATED_END_MARKER + '\n'
}

/** 组装整文件（新建时用）：frontmatter + 生成块 + 空手写区。 */
export function renderRoutineFile(facts, llmBody, hash) {
  return `${renderFrontmatter(facts)}\n\n${renderGeneratedBlock(facts, llmBody, hash)}`
}

/** 从已有文件里取 facts 哈希。 */
export function existingFactsHash(text) {
  const m = /<!-- sleep-routine:facts-hash: ([0-9a-f]+) -->/.exec(String(text ?? ''))
  return m ? m[1] : null
}

/**
 * 幂等替换：只替换 GENERATED_MARKER .. GENERATED_END_MARKER 之间的内容；
 * frontmatter 与 end 标记之后的手写内容原样保留。
 * 旧文件没有 end 标记时，marker 之后视为生成区（向后兼容只有单 marker 的旧文件）。
 */
export function replaceGeneratedBlock(existingText, newBlock) {
  const text = String(existingText ?? '')
  const start = text.indexOf(GENERATED_MARKER)
  if (start < 0) {
    throw new Error(`已有文件里没有 ${GENERATED_MARKER} 标记，拒绝覆盖（请手工确认）`)
  }
  const prefix = text.slice(0, start)
  const endIdx = text.indexOf(GENERATED_END_MARKER, start)
  if (endIdx < 0) return prefix + newBlock
  return prefix + newBlock + handSuffix(text)
}

/**
 * end 标记之后的手写区（原样返回，含前导换行处理）。
 * 幂等重写和 frontmatter 重建都用它，保证手写内容永不丢。
 */
export function handSuffix(text) {
  const src = String(text ?? '')
  const endIdx = src.indexOf(GENERATED_END_MARKER)
  if (endIdx < 0) return ''
  const raw = src.slice(endIdx + GENERATED_END_MARKER.length)
  return raw.trim() ? '\n' + raw.replace(/^\s*\n/, '').replace(/\s+$/, '') + '\n' : ''
}

/**
 * 用当前 facts 重新渲染 frontmatter（`related` 等派生字段跟着刷新），
 * 同时保留 end 标记之后的手写区。用于修历史文件的 frontmatter（如链接歧义）。
 */
export function renderWithFreshFrontmatter(facts, body, hash, existingText) {
  return renderFrontmatter(facts) + '\n\n' + renderGeneratedBlock(facts, body, hash) + handSuffix(existingText)
}

/** 生成块里的正文（给面板展示 / 校验用）。 */
export function extractGeneratedBody(text) {
  const src = String(text ?? '')
  const start = src.indexOf(GENERATED_MARKER)
  if (start < 0) return null
  const from = start + GENERATED_MARKER.length
  const endIdx = src.indexOf(GENERATED_END_MARKER, from)
  const region = src.slice(from, endIdx < 0 ? src.length : endIdx)
  return region.replace(/^<!-- sleep-routine:facts-hash: [0-9a-f]+ -->\s*/m, '').trim()
}

// ---------------------------------------------------------------------------
// 结构校验
// ---------------------------------------------------------------------------

/** LLM 正文必须包含的四个 level-2 章节（顺序固定）。 */
export const REQUIRED_SECTIONS = [
  '本周一句话',
  '进展（按项目 / 任务）',
  '反复出现的 blocker',
  '未闭环',
]

/** 校验 LLM 正文的结构；返回 {ok, errors}。 */
export function validateBody(llmBody) {
  const errors = []
  const body = String(llmBody ?? '').trim()
  if (!body) return { ok: false, errors: ['正文为空'] }
  if (/^```/m.test(body)) errors.push('正文含代码围栏（应只输出 markdown 正文）')
  const headings = splitByHeading(body, 2).map((s) => s.title.trim())
  let cursor = -1
  for (const want of REQUIRED_SECTIONS) {
    const idx = headings.findIndex((h) => h === want || h.startsWith(want))
    if (idx < 0) {
      errors.push(`缺少章节：## ${want}`)
      continue
    }
    if (idx < cursor) errors.push(`章节顺序错误：## ${want} 出现在前一节之前`)
    cursor = idx
  }
  const unexpected = headings.filter((h) => !REQUIRED_SECTIONS.some((w) => h === w || h.startsWith(w)))
  if (unexpected.length) errors.push(`出现计划外章节：${unexpected.join('、')}`)
  return { ok: errors.length === 0, errors }
}

/** 去掉正文开头的 H1（cli 会自己加 `# Routine <week>`，避免重复）。 */
export function stripLeadingH1(markdown) {
  return String(markdown ?? '')
    .replace(/^\s*#\s+.*\r?\n+/, '')
    .trim()
}

/** 从一份 routine 文件里取出本周结论区（面板「插入输入框」用）。 */
export function pullQuote(text, maxChars = 1200) {
  const body = extractGeneratedBody(text)
  if (!body) return ''
  const secs = splitByHeading(body, 2)
  const oneLiner = secs.find((s) => s.title.includes('本周一句话'))
  const open = secs.find((s) => s.title.includes('未闭环'))
  const parts = []
  if (oneLiner?.body) parts.push(`本周一句话：${oneLiner.body.replace(/\n+/g, ' ').trim()}`)
  if (open?.body) parts.push(`未闭环：\n${open.body.trim()}`)
  let out = parts.join('\n\n')
  if (out.length > maxChars) out = out.slice(0, maxChars - 1) + '…'
  return out
}
