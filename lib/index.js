/**
 * index.js — host half：只读 webServer API（+ 一个辅助 tool）。
 *
 *   GET /work-review/api/index                  → 日报/周报索引
 *   GET /work-review/api/report?date=YYYY-MM-DD → 当天 Dream（缺失回退 journal）
 *   GET /work-review/api/routine?week=YYYY-Www  → 周报 markdown 全文
 *
 * 只读边界：只允许 life/dreams、life/journal、life/routines 三个目录；
 * date/week 参数先按正则校验再拼路径，拒绝任意路径穿越。
 * 面板只读，不提供生成/写入接口（生成走 lib/cli.js）。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  REL,
  extractGeneratedBody,
  isoWeekOf,
  pullQuote,
  resolveVaultRoot,
  todayLocal,
  weekRange,
} from './core.js'
import { vaultHint } from './config.js'

export const name = 'work-review'
export const inject = ['webServer']

// ---------------------------------------------------------------------------
// 读取（全部只读 + 路径白名单）
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const WEEK_RE = /^\d{4}-W\d{2}$/

function readMarkdown(vaultRoot, relDir, name) {
  const abs = join(vaultRoot, relDir, name)
  try {
    if (!existsSync(abs)) return null
    return readFileSync(abs, 'utf8')
  } catch {
    return null
  }
}

function listDates(vaultRoot, relDir) {
  try {
    const dir = join(vaultRoot, relDir)
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n))
      .map((n) => n.slice(0, 10))
      .sort()
  } catch {
    return []
  }
}

function listRoutines(vaultRoot) {
  try {
    const dir = join(vaultRoot, REL.routines)
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((n) => /^\d{4}-W\d{2}\.md$/.test(n))
      .map((n) => n.slice(0, 8))
      .sort()
  } catch {
    return []
  }
}

/** frontmatter 里的几个标量（面板列表只读这三个字段）。 */
function routineMeta(text) {
  const status = /^status:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? ''
  const title = /^title:\s*"?(.*?)"?\s*$/m.exec(text)?.[1]?.trim() ?? ''
  return { status, title }
}

// ---------------------------------------------------------------------------
// handler
// ---------------------------------------------------------------------------

function json(res, code, payload) {
  const text = JSON.stringify(payload)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * 路由分发。拆出来便于单测（直接喂 {url, method}）。
 * 返回 {code, body}；handler 只负责写回。
 */
export function route({ url, method, vaultRoot, today = todayLocal() }) {
  const pathname = new URL(url ?? '/', 'http://localhost').pathname
  const sub = pathname.replace(/^\/work-review\/api/, '') || '/'
  if (method !== 'GET') return { code: 405, body: { ok: false, error: 'method not allowed' } }

  if (sub === '/' || sub === '/index') {
    const dreams = new Set(listDates(vaultRoot, REL.dreams))
    const journals = new Set(listDates(vaultRoot, REL.journal))
    const ingests = new Set(listDates(vaultRoot, REL.ingest))
    const dates = [...new Set([...dreams, ...journals, ...ingests])].sort().reverse()
    const currentWeek = isoWeekOf(today).weekStr
    const routines = listRoutines(vaultRoot).map((week) => {
      const text = readMarkdown(vaultRoot, REL.routines, `${week}.md`) ?? ''
      const meta = text ? routineMeta(text) : { status: '', title: '' }
      const range = weekRange(week)
      return {
        week,
        path: `${REL.routines}/${week}.md`,
        title: meta.title,
        status: meta.status,
        start: range.start,
        end: range.end,
        current: week === currentWeek,
        bytes: text ? Buffer.byteLength(text) : 0,
      }
    })
    return {
      code: 200,
      body: {
        ok: true,
        vault: vaultRoot,
        today,
        currentWeek,
        days: dates.map((date) => ({
          date,
          dream: dreams.has(date),
          journal: journals.has(date),
          ingest: ingests.has(date),
        })),
        routines,
        sources: REL,
      },
    }
  }

  if (sub === '/report') {
    const date = new URL(url, 'http://localhost').searchParams.get('date') ?? today
    if (!DATE_RE.test(date)) return { code: 400, body: { ok: false, error: 'date 需为 YYYY-MM-DD' } }
    const dream = readMarkdown(vaultRoot, REL.dreams, `${date}.md`)
    const journal = readMarkdown(vaultRoot, REL.journal, `${date}.md`)
    if (!dream && !journal) {
      return { code: 404, body: { ok: false, error: `没有 ${date} 的 Dream 或 journal` } }
    }
    return {
      code: 200,
      body: {
        ok: true,
        date,
        dream: dream ? { path: `${REL.dreams}/${date}.md`, markdown: dream } : null,
        journal: journal ? { path: `${REL.journal}/${date}.md`, markdown: journal } : null,
        preferred: dream ? 'dream' : 'journal',
      },
    }
  }

  if (sub === '/routine') {
    const week =
      new URL(url, 'http://localhost').searchParams.get('week') ?? isoWeekOf(today).weekStr
    if (!WEEK_RE.test(week)) return { code: 400, body: { ok: false, error: 'week 需为 YYYY-Www' } }
    let range
    try {
      range = weekRange(week)
    } catch (err) {
      return { code: 400, body: { ok: false, error: `非法 ISO 周: ${week}` } }
    }
    const text = readMarkdown(vaultRoot, REL.routines, `${week}.md`)
    if (!text) {
      return {
        code: 404,
        body: { ok: false, error: `还没有 ${week} 的周报`, week, start: range.start, end: range.end },
      }
    }
    const meta = routineMeta(text)
    return {
      code: 200,
      body: {
        ok: true,
        week,
        start: range.start,
        end: range.end,
        path: `${REL.routines}/${week}.md`,
        title: meta.title,
        status: meta.status,
        markdown: text,
        body: extractGeneratedBody(text) ?? '',
        quote: pullQuote(text),
        bytes: Buffer.byteLength(text),
      },
    }
  }

  return { code: 404, body: { ok: false, error: `未知路由: ${sub}` } }
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
  const vaultRoot = resolveVaultRoot(config.vaultRoot)
  const unavailable = vaultRoot ? '' : `工作回顾（Work Review）还没有配置 vault：${vaultHint()}`

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/work-review/api',
        handler: async (req, res) => {
          try {
            if (!vaultRoot) {
              json(res, 503, { ok: false, error: unavailable })
              return
            }
            const result = route({ url: req.url, method: req.method, vaultRoot })
            json(res, result.code, result.body)
          } catch (err) {
            json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        },
      }),
    'work-review: read-only api',
  )

  // 可选 tool：给 agent 一个和面板同源的只读入口（服务不存在时静默跳过）
  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
  if (tools && typeof tools.register === 'function') {
    try {
    ctx.effect(
      () =>
        tools.register({
          name: 'work_review_status',
          description:
            '只读查询 工作回顾（Work Review）：返回周报索引、指定周的周报摘要或指定日期的 Dream/journal 路径。不写文件。',
          parameters: {
            type: 'object',
            properties: {
              week: { type: 'string', description: 'ISO 周，如 2026-W44（可选）' },
              date: { type: 'string', description: '日期，如 2026-10-27（可选）' },
            },
          },
          output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: String(value) }],
          },
          async execute(args) {
            if (!vaultRoot) return JSON.stringify({ ok: false, error: unavailable })
            if (args?.date) {
              const r = route({ url: `/work-review/api/report?date=${args.date}`, method: 'GET', vaultRoot })
              return JSON.stringify(r.body.ok ? { ok: true, date: args.date, paths: [r.body.dream?.path, r.body.journal?.path].filter(Boolean) } : r.body)
            }
            const r = route({
              url: `/work-review/api/routine${args?.week ? `?week=${args.week}` : ''}`,
              method: 'GET',
              vaultRoot,
            })
            if (!r.body.ok) {
              const idx = route({ url: '/work-review/api/index', method: 'GET', vaultRoot })
              return JSON.stringify({ ok: false, error: r.body.error, routines: idx.body.routines })
            }
            return JSON.stringify({
              ok: true,
              week: r.body.week,
              status: r.body.status,
              quote: r.body.quote,
              body: r.body.body.slice(0, 2000),
            })
          },
        }),
      'work-review: status tool',
    )
    } catch (err) {
      // tool 是可选增强：注册失败不影响只读 API
      console.warn('[work-review] status tool 注册失败:', err instanceof Error ? err.message : String(err))
    }
  }
}
