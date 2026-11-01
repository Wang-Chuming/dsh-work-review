/**
 * daily.js — 一天的事实（facts）收集，nightly.js 的输入层。
 *
 * 与 core.js 的周 facts 同源：周报回答「这一周发生了什么」，日报回答「昨天
 * 发生了什么、今天该做什么」。这里只取确定性数据，不调模型、不写文件：
 *
 *   - life/journal/<date>.md         Progress / Blockers / Threads / Stats / 审批块
 *   - life/notes/ingest/<date>.md    自动入库条目与写回条数
 *   - life/tasks/*.md                未关闭任务（按 updated 倒序）
 *   - life/dreams/<date>.md          已有早报（重跑时用于判断幂等）
 *   - <vault> 的 git                 窗口内的 commit + 未提交脏文件
 *
 * 「一天」默认从 05:00 算起（`dayStartHour` 可配）：凌晨的活算前一天，这是
 * 夜间流程的惯例——05:00 跑的时候，昨天的定义不该在 00:00 被切断。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import {
  REL,
  parseDream,
  parseFrontmatter,
  parseIngest,
  parseJournal,
  relPath,
  todayLocal,
  weekdayLabel,
  weekdayOf,
} from './core.js'

/** 默认的一天起点（小时，0-23）。 */
export const DAY_START_HOUR = 5

/** 视为「已关闭」的任务状态；其余都进今日待办候选。 */
const CLOSED_STATUS = /完成|归档|搁置|放弃|关闭|done|closed|archived|shelved|cancelled/i

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function safeRead(abs) {
  try {
    return readFileSync(abs, 'utf8')
  } catch {
    return null
  }
}

function addDays(dateStr, delta) {
  const d = new Date(`${dateStr}T00:00:00`)
  d.setDate(d.getDate() + delta)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function localIso(d) {
  const pad = (n) => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

/**
 * date spec：`today` | `yesterday` | `YYYY-MM-DD` | 负数偏移（`-1` = 昨天）。
 * 与 weekly CLI 的 `--week last` 语义对齐：默认总结「昨天」。
 */
export function resolveDateSpec(spec = 'yesterday', today = todayLocal()) {
  const raw = String(spec ?? '').trim()
  if (!raw || raw === 'yesterday' || raw === 'last' || raw === '-1') return addDays(today, -1)
  if (raw === 'today' || raw === 'current') return today
  if (DATE_RE.test(raw)) return raw
  if (/^-\d+$/.test(raw)) return addDays(today, Number(raw))
  throw new Error(`无法识别的日期: ${raw}（支持 today / yesterday / YYYY-MM-DD / -1）`)
}

/**
 * 一天的时间窗口：[date 的 dayStartHour, 次日 dayStartHour)。
 * 返回本地时区 ISO 字符串，git 的 --since/--until 直接吃这个格式。
 */
export function dayWindow(dateStr, dayStartHour = DAY_START_HOUR) {
  if (!DATE_RE.test(String(dateStr))) throw new Error(`不是合法日期: ${dateStr}`)
  const hour = Number.isFinite(dayStartHour) ? Math.min(23, Math.max(0, dayStartHour)) : DAY_START_HOUR
  const start = new Date(`${dateStr}T00:00:00`)
  start.setHours(hour, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return {
    start: localIso(start),
    end: localIso(end),
    dayStartHour: hour,
    date: dateStr,
  }
}

function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 20000 })
  if (res.error || res.status !== 0) return null
  return res.stdout ?? ''
}

/** 窗口内的 commit 与未提交脏文件。vault 不是 git 仓库时返回 available:false。 */
export function collectDayGit(vaultRoot, window) {
  const probe = git(['rev-parse', '--is-inside-work-tree'], vaultRoot)
  if (probe == null || probe.trim() !== 'true') {
    return { available: false, branch: '', commits: [], dirty: [] }
  }
  const branch = (git(['rev-parse', '--abbrev-ref', 'HEAD'], vaultRoot) ?? '').trim()
  const raw = git(
    [
      'log',
      '-n',
      '200',
      `--since=${window.start}`,
      `--until=${window.end}`,
      '--date=iso-strict',
      '--pretty=format:%h%x09%ad%x09%s',
    ],
    vaultRoot,
  )
  const commits = []
  if (raw) {
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue
      const [sha, time, msg] = line.split('\t')
      if (!sha) continue
      commits.push({ sha, time: time ?? '', msg: msg ?? '' })
    }
  }
  const dirtyRaw = git(['status', '--porcelain=v1', '-uall'], vaultRoot)
  const dirty = []
  if (dirtyRaw) {
    for (const line of dirtyRaw.split(/\r?\n/)) {
      if (!line.trim()) continue
      dirty.push({ status: line.slice(0, 2).trim(), path: line.slice(3).trim() })
    }
  }
  return { available: true, branch, commits, dirty }
}

/** 未关闭任务：status 不属于完成/归档类。按 updated 倒序，最多 limit 条。 */
export function collectOpenTasks(vaultRoot, limit = 10) {
  const dir = join(vaultRoot, REL.tasks)
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const tasks = []
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    const abs = join(dir, name)
    const md = safeRead(abs)
    if (!md) continue
    const { data } = parseFrontmatter(md)
    const status = String(data.status ?? '')
    if (CLOSED_STATUS.test(status)) continue
    tasks.push({
      task: name.replace(/\.md$/, ''),
      path: relPath(vaultRoot, abs),
      status,
      area: String(data.area ?? ''),
      updated: String(data.updated ?? ''),
    })
  }
  tasks.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : a.task.localeCompare(b.task)))
  return tasks.slice(0, limit)
}

/**
 * 组装一天的事实包。opts:
 *   {vaultRoot, date, today, dayStartHour, withGit=true, taskLimit=10}
 */
export function buildDailyFacts(opts = {}) {
  const vaultRoot = opts.vaultRoot
  if (!vaultRoot) throw new Error('缺少 vaultRoot')
  const today = opts.today ?? todayLocal()
  const date = resolveDateSpec(opts.date ?? 'yesterday', today)
  const window = dayWindow(date, opts.dayStartHour ?? DAY_START_HOUR)

  const journalAbs = join(vaultRoot, REL.journal, `${date}.md`)
  const ingestAbs = join(vaultRoot, REL.ingest, `${date}.md`)
  const dreamAbs = join(vaultRoot, REL.dreams, `${date}.md`)
  const journalMd = safeRead(journalAbs)
  const dreamMd = safeRead(dreamAbs)

  const journal = journalMd ? parseJournal(journalMd) : null
  const ingest = parseIngest(safeRead(ingestAbs))
  const existingDream = dreamMd ? parseDream(dreamMd) : null
  const git = opts.withGit === false ? { available: false, branch: '', commits: [], dirty: [] } : collectDayGit(vaultRoot, window)
  const openTasks = collectOpenTasks(vaultRoot, opts.taskLimit ?? 10)

  const journalProgress = journal?.progress ?? []
  const journalBlockers = journal?.blockers ?? []
  const journalThreads = journal?.threads ?? []

  return {
    date,
    today,
    weekday: weekdayOf(date),
    weekdayLabel: weekdayLabel(date),
    window,
    sources: {
      journal: journalMd ? relPath(vaultRoot, journalAbs) : null,
      ingest: ingest ? relPath(vaultRoot, ingestAbs) : null,
      dream: dreamMd ? relPath(vaultRoot, dreamAbs) : null,
      tasks: REL.tasks,
    },
    journal: journal
      ? {
          title: journal.title,
          created: journal.created,
          progress: journalProgress,
          blockers: journalBlockers,
          threads: journalThreads,
          selfCheck: journal.selfCheck ?? [],
          stats: journal.stats ?? [],
          review: journal.review ?? { entries: [], done: [], pending: [] },
        }
      : null,
    ingest,
    existingDream: existingDream
      ? {
          title: existingDream.title,
          taskPlans: existingDream.taskPlans.length,
          gitPlans: existingDream.gitPlans.length,
          focus: existingDream.focus.length,
        }
      : null,
    tasks: openTasks,
    git,
    missing: { journal: !journalMd, ingest: !ingest, dream: !dreamMd },
  }
}

/** 事实包 → 送进 prompt 的紧凑结构（截断长文本，只保留可回查的要点）。 */
export function dailyFactsForPrompt(facts, options = {}) {
  const clip = (text, max) => {
    const s = String(text ?? '').trim()
    return s.length <= max ? s : s.slice(0, max - 1) + '…'
  }
  const bulletText = (line) => String(line ?? '').replace(/^\s*-\s*/, '').trim()
  return {
    date: facts.date,
    weekday: facts.weekdayLabel,
    window: `${facts.window.start} → ${facts.window.end}`,
    journal: facts.journal
      ? {
          title: clip(facts.journal.title, 120),
          progress: facts.journal.progress.slice(0, 12).map((l) => clip(bulletText(l), 400)),
          blockers: facts.journal.blockers.slice(0, 8).map((l) => clip(bulletText(l), 300)),
          threads: facts.journal.threads.slice(0, 8).map((l) => clip(bulletText(l), 300)),
          stats: facts.journal.stats.slice(0, 8).map((l) => clip(bulletText(l), 200)),
        }
      : null,
    ingest: facts.ingest
      ? {
          proposals: facts.ingest.proposals,
          writtenBack: facts.ingest.writtenBack,
          items: facts.ingest.writeBack.slice(0, 8).map((i) => clip(`${i.id}: ${i.result}`, 200)),
        }
      : null,
    existingDream: facts.existingDream,
    tasks: facts.tasks.slice(0, options.taskLimit ?? 10).map((t) => ({
      task: t.task,
      path: t.path,
      status: t.status,
      area: t.area,
      updated: t.updated,
    })),
    git: facts.git.available
      ? {
          branch: facts.git.branch,
          commits: facts.git.commits.slice(0, 40).map((c) => ({
            sha: c.sha,
            msg: clip(c.msg, 160),
          })),
          dirtyCount: facts.git.dirty.length,
          dirty: facts.git.dirty.slice(0, 30).map((d) => `${d.status} ${d.path}`),
        }
      : { available: false },
    missing: facts.missing,
  }
}

/** facts → 纯文本（prompt 主体）。 */
export function dailyFactsText(facts, options = {}) {
  return JSON.stringify(dailyFactsForPrompt(facts, options), null, 2)
}
