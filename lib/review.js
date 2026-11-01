#!/usr/bin/env node
/**
 * review.js — 早报（Dream）里 T/G 计划的审批执行器。
 *
 *   life/dreams/<date>.md ──parseDream──► T/G 计划
 *      ├─ 自动批准＝常规  → 交给一个 headless agent 逐条执行（--run / --live）
 *      └─ 自动批准＝升级  → 只列出，永不执行
 *   agent 的最终 JSON ──► 审批块写回 life/journal/<date>.md
 *
 * 安全默认值：
 *   - 默认只打印计划，不调模型、不写任何文件；
 *   - `--run` 起 headless 会话，但权限是 read-only，agent 只能看不能改；
 *   - `--live` 才把权限放宽到 workspace-write，允许改任务/本地 commit；
 *   - push、pull、sync、删除、归档永远不在授权范围内，prompt 里也写死。
 *
 * 审批结果写成 core.parseReviewBlock 认识的 bullet，所以周报的审批台账能直接
 * 读回这些条目：`- <date> <time> 审查通过 · T1 · 执行：... · 提交：`sha``。
 *
 * 退出码：0 成功/无计划；2 参数或环境错误；3 早报缺失；5 provider 失败；6 输出无法解析。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import * as core from './core.js'
import * as config from './config.js'
import { buildDailyFacts, resolveDateSpec } from './daily.js'
import { runProvider } from './cli.js'

const DREAM_DIR = core.REL.dreams
const JOURNAL_DIR = core.REL.journal
const REVIEW_BEGIN = '<!-- sleep-review:begin -->'
const REVIEW_END = '<!-- sleep-review:end -->'

const ROUTINE = /^常规/
const ESCALATED = /^升级/

function usage() {
  return `用法: node lib/review.js [选项]

执行某天早报（Dream）里「自动批准：常规」的 T/G 计划。

选项:
  --date <spec>          today | yesterday | YYYY-MM-DD | -1（默认 yesterday）
  --vault <dir>          vault 根目录（默认 $DSH_WORK_REVIEW_VAULT 或配置里的 vaultRoot）
  --run                  起 headless 会话执行（权限 read-only，只能读）
  --live                 执行并允许写入 + 本地 commit（权限 workspace-write）
  --dry-run              只打印计划（默认行为，等价于不传 --run/--live）
  --json                 计划输出 JSON（默认也是 JSON，保留开关）
  --prompt-out <path>    把 review prompt 写到指定文件（调试用）
  --timeout <sec>        单次 provider 超时（默认 900）
  --provider <id>        auto | dsh-default | 配置文件里的 provider id（默认 auto）
  --no-write             即使执行了也不把审批块写回 journal
  --quiet                不往 stderr 打日志
  -h, --help             显示帮助

面板接线：把 ~/.dsh/work-review.json 的 approve 段指向本脚本即可：
  "approve": {
    "label": "执行自动审批",
    "python": "node",
    "script": "/绝对路径/dsh-work-review/lib/review.js",
    "args": ["--date", "{date}", "--live"]
  }
`
}

export function parseArgs(argv) {
  const args = {
    date: 'yesterday',
    vault: '',
    run: false,
    live: false,
    promptOut: '',
    timeout: 900,
    provider: 'auto',
    write: true,
    quiet: false,
    json: true,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) throw new Error(`${arg} 缺少参数值`)
      return argv[i]
    }
    switch (arg) {
      case '--date': args.date = next(); break
      case '--vault': args.vault = next(); break
      case '--run': args.run = true; break
      case '--live': args.run = true; args.live = true; break
      case '--dry-run': args.run = false; break
      case '--json': args.json = true; break
      case '--prompt-out': args.promptOut = next(); break
      case '--timeout': args.timeout = Number(next()); break
      case '--provider': args.provider = next(); break
      case '--no-write': args.write = false; break
      case '--quiet': args.quiet = true; break
      case '-h':
      case '--help': args.help = true; break
      default:
        throw new Error(`未知参数: ${arg}`)
    }
  }
  return args
}

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

/** 缓存目录：不可写时退到系统临时目录；再不行返回空串（调用方跳过写缓存）。 */
function cacheDir() {
  const candidates = [config.resolveCacheDir(), join(process.env.TMPDIR || '/tmp', 'work-review-cache')]
  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true })
      return dir
    } catch {
      /* 试下一个 */
    }
  }
  return ''
}

// ---------------------------------------------------------------------------
// 计划分类
// ---------------------------------------------------------------------------

/**
 * 把 parseDream 的结果分成「可自动执行」与「升级」两组。
 * 没有写自动批准、或写了第三种取值的，一律按升级处理——fail-safe。
 */
export function classifyPlans(dream) {
  const approved = []
  const escalated = []
  const push = (item) => {
    const approval = String(item.approval ?? '').trim()
    const entry = {
      kind: item.kind ?? (item.id?.startsWith('G') ? 'git' : 'task'),
      id: item.id || '',
      title: item.title || '',
      approval,
    }
    if (!entry.id) {
      escalated.push({ ...entry, reason: '缺少 T/G 编号，无法执行' })
      return
    }
    if (ROUTINE.test(approval)) approved.push(entry)
    else if (ESCALATED.test(approval)) escalated.push({ ...entry, reason: approval.replace(/^升级[（(]?/, '').replace(/[）)]$/, '') || '标记为升级' })
    else escalated.push({ ...entry, reason: '未写自动批准，按升级处理' })
  }
  for (const plan of dream?.taskPlans ?? []) push({ ...plan, kind: 'task' })
  for (const plan of dream?.gitPlans ?? []) push({ ...plan, kind: 'git' })
  return { approved, escalated }
}

// ---------------------------------------------------------------------------
// prompt
// ---------------------------------------------------------------------------

/** 执行规则：确定性脚本能保证的事，模型不得自行放宽。 */
const REVIEW_RULES = `## 执行规则（硬性）

1. **只执行列出的常规项。** 上面 \`approved\` 之外的 T/G 一律不执行；升级项保持原样。
2. **任务更新（T）**：向任务文件末尾的 \`## 进度\` 追加一条 \`- <日期>：<要点>\`；
   只有计划里「建议」与「当前」不同且被批准时才改 frontmatter 的 status。
   不要改任务的 title/area/domain，不要新增 frontmatter 字段。
3. **提交（G）**：只 \`git add\` 计划「纳入」里逐条列出的路径，用给定的 commit message；
   不要 \`git add -A\`/\`git add .\`，不要提交未列出的路径，不要删除、重命名或归档文件。
4. **绝不 push / pull / sync / 删除分支 / 改写历史。** 本地 commit 是终点。
5. **规则源只读。** \`AGENTS.md\`、\`SCHEMA.md\`、\`ARCHITECTURE.md\`、\`.specs/\`、\`scripts/\`、
   \`.githooks/\` 等治理文件即使出现在计划里也不动；发现它们被标成常规，记一条升级。
6. **不确定就跳过。** 前置条件不满足、路径不存在、计划与事实冲突时不要猜：跳过并在结果里写原因。
7. 不要创建新文件（除了任务要求的进度追加），不要改工作区之外的路径。

## 最终输出（必须是最后一块）

执行完成后，输出**一个 JSON 代码块**，不要再写别的：

\`\`\`json
{
  "items": [
    { "id": "T1", "verdict": "done", "note": "追加进度 2 行", "commit": null },
    { "id": "G1", "verdict": "done", "note": "提交 3 个路径", "commit": "abc1234" },
    { "id": "G2", "verdict": "skipped", "note": "前置条件未满足：文件不存在", "commit": null }
  ],
  "notes": "一句话总结"
}
\`\`\`

verdict 只能是 \`done\` / \`skipped\` / \`failed\`。\`commit\` 只在真的产生本地 commit 时填短 sha。`

/** facts + Dream 计划 → review prompt。 */
export function buildReviewPrompt({ facts, dream, approved, escalated, live }) {
  const plan = {
    date: facts.date,
    vault: facts.sources ?? undefined,
    dreamPath: facts.sources?.dream ?? `${DREAM_DIR}/${facts.date}.md`,
    runtime: live ? 'live（workspace-write：可以改任务、可以本地 commit）' : 'read-only（只读：不许改任何文件）',
  }
  return `你是今天早报的执行者。早报已经由作者审阅过「自动批准」列，你只做被授权的那部分。

## 环境

- vault：\`${facts.vaultRoot ?? ''}\`
- 早报：\`${plan.dreamPath}\`（也可用下面的计划数据，不必重复读文件）
- 日期：${plan.date}（${facts.weekdayLabel}）
- 本次权限：${plan.runtime}

## 计划数据

\`\`\`json
${JSON.stringify(
    {
      approved: approved.map((a) => ({ id: a.id, kind: a.kind, title: a.title })),
      escalated: escalated.map((e) => ({ id: e.id, kind: e.kind, title: e.title, reason: e.reason })),
      currentStatus: (dream?.taskPlans ?? []).map((p) => ({ id: p.id, file: p.file, current: p.current, suggestion: p.suggestion, progress: p.progress })),
      gitPlans: (dream?.gitPlans ?? []).map((p) => ({ id: p.id, repo: p.repo, include: p.include, message: p.message })),
    },
    null,
    2,
  )}
\`\`\`

${REVIEW_RULES}

## 汇报口吻

- 中文；每条结论带证据（路径、sha、实际追加的行数）。
- 不要复述规则，不要解释你理解了任务；只做，然后给 JSON。`
}

// ---------------------------------------------------------------------------
// 结果解析与审批块
// ---------------------------------------------------------------------------

/** 从 agent 输出里取最后一个 JSON 块；解析失败返回 null。 */
export function extractAgentResult(text) {
  const source = String(text ?? '')
  const blocks = [...source.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)].map((m) => m[1].trim())
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(blocks[i])
      if (parsed && Array.isArray(parsed.items)) return parsed
    } catch {
      /* 继续试更早的块 */
    }
  }
  // 没有围栏时，从右往左找第一个「括号配平」的 JSON 对象。
  // 逐字符配平（跳过字符串里的括号），避免非贪婪正则截断嵌套对象。
  const starts = [...source.matchAll(/\{/g)].map((m) => m.index).slice(-20)
  for (let i = starts.length - 1; i >= 0; i -= 1) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let j = starts[i]; j < source.length; j += 1) {
      const ch = source[j]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          try {
            const parsed = JSON.parse(source.slice(starts[i], j + 1))
            if (parsed && Array.isArray(parsed.items)) return parsed
          } catch {
            /* 换下一个起点 */
          }
          break
        }
      }
    }
  }
  return null
}

function shortNote(text, max = 160) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

/**
 * agent 结果 → 审批 bullet（core.parseReviewBlock 可解析）。
 * done → 「审查通过 … 执行：」；skipped → 「审查通过 … 未执行：」
 * failed → 「未通过 … 执行：」；升级项 → 「升级（原因：…）… 未执行」。
 */
export function renderReviewBullets(review, { date, time = stamp() }) {
  const lines = []
  const items = Array.isArray(review?.items) ? review.items : []
  for (const item of items) {
    const id = String(item.id ?? '').trim()
    if (!id) continue
    const note = shortNote(item.note ?? '')
    const commit = /^[0-9a-f]{7,40}$/.test(String(item.commit ?? '')) ? ` · 提交：\`${item.commit}\`` : ''
    if (item.verdict === 'done') {
      lines.push(`- ${date} ${time} 审查通过 · ${id} · 执行：${note || '已执行'}${commit}`)
    } else if (item.verdict === 'skipped') {
      lines.push(`- ${date} ${time} 审查通过 · ${id} · 跳过：${note || '未执行'}`)
    } else {
      lines.push(`- ${date} ${time} 未通过 · ${id} · 失败：${note || '未完成'}`)
    }
  }
  for (const item of review?.escalated ?? []) {
    const reason = shortNote(item.reason ?? item.approval ?? '升级', 80)
    lines.push(`- ${date} ${time} 升级（原因：${reason}）· ${item.id} · 未执行`)
  }
  if (review?.notes) lines.push(`- 总结：${shortNote(review.notes, 240)}`)
  return lines.join('\n')
}

/** 把审批块写进 journal 正文（有标记就替换，没有就追加一节）。 */
export function applyReviewBlock(journalText, bullets) {
  const block = `${REVIEW_BEGIN}\n${bullets}\n${REVIEW_END}`
  if (journalText && journalText.includes(REVIEW_BEGIN) && journalText.includes(REVIEW_END)) {
    const start = journalText.indexOf(REVIEW_BEGIN)
    const end = journalText.indexOf(REVIEW_END) + REVIEW_END.length
    return `${journalText.slice(0, start)}${block}${journalText.slice(end)}`
  }
  return `${String(journalText ?? '').replace(/\s+$/, '')}\n\n## 自动审批\n\n${block}\n`
}

/** 无 journal 时补一个最小骨架（title 由调用方补）。 */
export function journalSkeleton(date) {
  return `---\ntype: journal\ndomain: life\ntitle: "Journal ${date}"\ncreated: ${date}\nupdated: ${date}\n---\n\n# ${date}\n\n`
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export async function main(argv = process.argv.slice(2)) {
  let args
  try {
    args = parseArgs(argv)
  } catch (err) {
    console.error(`参数错误: ${err.message}\n\n${usage()}`)
    return 2
  }
  if (args.help) {
    console.log(usage())
    return 0
  }

  const vaultRoot = core.resolveVaultRoot(args.vault)
  if (!vaultRoot) {
    console.error(`${config.vaultHint()}\n`)
    return 2
  }
  let date
  try {
    date = resolveDateSpec(args.date)
  } catch (err) {
    console.error(err.message)
    return 2
  }

  const dreamAbs = join(vaultRoot, DREAM_DIR, `${date}.md`)
  if (!existsSync(dreamAbs)) {
    console.error(`找不到早报: ${dreamAbs}（先跑 node lib/nightly.js --date ${date}）`)
    return 3
  }
  const dream = core.parseDream(readFileSync(dreamAbs, 'utf8'))
  const facts = buildDailyFacts({ vaultRoot, date })
  facts.vaultRoot = vaultRoot

  const { approved, escalated } = classifyPlans(dream)
  const plan = {
    date,
    dream: `${DREAM_DIR}/${date}.md`,
    approvedCount: approved.length,
    escalatedCount: escalated.length,
    approved,
    escalated,
  }
  if (!args.run) {
    console.log(JSON.stringify(plan, null, 2))
    if (!args.quiet) {
      console.error(
        approved.length
          ? `只打印计划；执行加 --run（只读）或 --live（可写 + 本地 commit）。`
          : '没有可自动执行的常规项。',
      )
    }
    return 0
  }

  const promptText = buildReviewPrompt({ facts, dream, approved, escalated, live: args.live })
  if (args.promptOut) writeFileSync(resolve(args.promptOut), promptText)
  if (!args.quiet) {
    console.error(
      `[${stamp()}] review ${date}: approved=${approved.length} escalated=${escalated.length} live=${args.live} prompt=${promptText.length} chars`,
    )
  }

  const providers = config.resolveProviders({ vaultRoot })
  const wanted = args.provider === 'auto' ? providers : providers.filter((p) => p.id === args.provider)
  if (!wanted.length) {
    console.error(`未知 provider: ${args.provider}`)
    return 2
  }
  let output = null
  for (const provider of wanted) {
    const result = await runProvider({
      provider,
      promptText,
      vaultRoot,
      timeoutSec: args.timeout,
      log: (msg) => {
        if (!args.quiet) console.error(`[${stamp()}] ${msg}`)
      },
      permissionMode: args.live ? 'workspace-write' : 'read-only',
    })
    if (result.ok) {
      output = result.stdout
      break
    }
  }
  if (!output) {
    console.error('所有 provider 都失败；审批块未写入。详见缓存目录日志。')
    return 5
  }

  const parsed = extractAgentResult(output)
  if (!parsed) {
    const dir = cacheDir()
    const rawPath = dir ? join(dir, `review-unparsed-${date}.md`) : ''
    if (rawPath) writeFileSync(rawPath, output)
    console.error(`无法从模型输出里解析 JSON 结果${rawPath ? `；原始输出已存 ${rawPath}` : ''}`)
    return 6
  }

  const merged = { ...parsed, escalated }
  const bullets = renderReviewBullets(merged, { date })
  if (args.write) {
    const journalAbs = join(vaultRoot, JOURNAL_DIR, `${date}.md`)
    const existing = existsSync(journalAbs) ? readFileSync(journalAbs, 'utf8') : journalSkeleton(date)
    mkdirSync(join(vaultRoot, JOURNAL_DIR), { recursive: true })
    writeFileSync(journalAbs, applyReviewBlock(existing, bullets))
    if (!args.quiet) console.error(`[${stamp()}] 审批块已写入 ${journalAbs}`)
  }

  console.log(
    JSON.stringify(
      {
        date,
        live: args.live,
        approved: approved.map((a) => a.id),
        escalated: escalated.map((e) => e.id),
        result: parsed,
        wroteJournal: args.write,
      },
      null,
      2,
    ),
  )
  return 0
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]).endsWith(join('lib', 'review.js'))
if (isDirectRun) {
  main().then((code) => {
    process.exitCode = code
  })
}
