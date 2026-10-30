/**
 * prompt.js — facts pack → LLM prompt；以及输出后的结构/词汇校验规则。
 *
 * 六条规则在这里落成文字；core.js 只给数据，不掺规则。
 * 词汇复用的做法：把「输入里出现过的术语」显式列进 prompt，输出后再反向核对。
 */

import { REQUIRED_SECTIONS, splitByHeading } from './core.js'

/** prompt 版本；改动规则时递增，使 facts 哈希随之变化（触发重新合成）。 */
export const PROMPT_VERSION = 'routine-v2'

/** 模板/章节本身用到的英文词（不算「输入外新词」）。 */
const STRUCTURAL_TERMS = new Set([
  'routine',
  'blocker',
  'blockers',
  'w',
])

/** facts 里单个字段送进 prompt 的最大长度（保持引用可回查，不整段搬）。 */
const FIELD_CLIP = {
  summary: 700,
  progress: 500,
  blocker: 500,
  thread: 500,
  itemResult: 700,
  itemBasis: 500,
  itemNext: 500,
  plan: 400,
  commit: 160,
}

function clip(text, max) {
  const s = String(text ?? '').trim()
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

/** facts pack → 送进 prompt 的紧凑结构（只保留合成需要的字段）。 */
export function factsForPrompt(facts) {
  return {
    week: facts.week,
    start: facts.start,
    end: facts.end,
    today: facts.today,
    complete: facts.complete,
    days: facts.days.map((d) => ({
      date: d.date,
      weekday: d.weekdayLabel,
      dream: d.dream,
      journal: d.journal,
      dreamSummary: clip(d.dreamSummary, FIELD_CLIP.summary),
      items: d.items.map((i) => ({
        title: i.title,
        result: clip(i.result, FIELD_CLIP.itemResult),
        next: clip(i.next, FIELD_CLIP.itemNext),
      })),
      taskPlans: d.taskPlans.map((p) => ({
        id: p.id,
        kind: p.kind,
        name: clip(p.title, FIELD_CLIP.plan),
        approval: clip(p.approval, 60),
      })),
      gitPlans: d.gitPlans.map((g) => ({ id: g.id, title: clip(g.title, FIELD_CLIP.plan) })),
      focus: d.focus.map((f) => ({ n: f.n, title: clip(f.title, FIELD_CLIP.plan) })),
      progress: d.progress.map((p) => clip(p, FIELD_CLIP.progress)),
      blockers: d.blockers.map((b) => clip(b, FIELD_CLIP.blocker)),
      threads: d.threads.map((t) => clip(t, FIELD_CLIP.thread)),
      review: { done: d.review.done, pending: d.review.pending },
      ingest: d.ingestDetail
        ? { proposals: d.ingestDetail.proposals, writtenBack: d.ingestDetail.writtenBack }
        : null,
      missing: d.missing,
    })),
    gaps: facts.gaps,
    gapDetail: facts.gapDetail,
    coverage: facts.coverage,
    blockerRecurrence: facts.blockers
      .filter((b) => b.count >= 2)
      .map((b) => ({ key: b.key, days: b.count, dates: b.dates })),
    git: {
      available: facts.git.available,
      byDay: facts.git.by_day,
      commits: facts.git.commits.map((c) => ({ sha: c.sha, date: c.date, msg: clip(c.msg, FIELD_CLIP.commit) })),
    },
    tasks: {
      touched: facts.tasks.touched.map((t) => ({ task: t.task, path: t.path, status: t.status, area: t.area })),
      statusChanges: facts.tasks.status_changes,
    },
    reviewLedger: facts.reviewLedger,
  }
}

/**
 * 从任意文本抽拉丁词（≥2 字符；含数字/下划线/点/连字符）。
 * 刻意不在 '/' 上合并：路径按片段核对。否则模型写 "life/notes/ingest/x.md" 时
 * 整条路径是一个 token，任何一个拼错的路径片段都会把整条合法路径判成新术语。
 */
export function latinTokens(text) {
  const out = new Set()
  for (const m of String(text ?? '').matchAll(/[A-Za-z][A-Za-z0-9][A-Za-z0-9_.+\-]*/g)) {
    out.add(m[0])
  }
  return out
}

/** 抽输出里的日期引用（YYYY-MM-DD 与 MM-DD 两种）。 */
export function extractDates(text) {
  const out = new Set()
  for (const m of String(text ?? '').matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)) out.add(m[1])
  for (const m of String(text ?? '').matchAll(/(?<![\d-])(\d{2}-\d{2})(?![\d-])/g)) out.add(m[1])
  return [...out]
}

/**
 * 引用核对：输出里的每个日期都必须能在输入 facts 里找到（YYYY-MM-DD 直接出现，
 * 或 MM-DD 作为子串出现）。防止模型编造日期。
 */
export function checkCitations(body, facts) {
  const corpus = JSON.stringify(factsForPrompt(facts))
  const unknown = []
  for (const date of extractDates(body)) {
    const needle = date.length === 10 ? date : date
    if (corpus.includes(needle)) continue
    // MM-DD 可能对应 facts 里的 YYYY-MM-DD 后缀
    if (date.length === 5 && corpus.includes(`-${date}`)) continue
    unknown.push(date)
  }
  return { ok: unknown.length === 0, unknown }
}

/** 允许出现的术语集合（小写）：facts 里出现过的 + 结构词 + W<ww>。 */
export function buildVocabulary(facts) {
  const allowed = new Set(STRUCTURAL_TERMS)
  // 用「模型实际看到的 JSON 文本」建词表（含字段名，如 dream / writtenBack）：
  // 规则是「只用输入里出现过的词」，模型能看到的都算输入。
  const text = JSON.stringify(factsForPrompt(facts))
  for (const token of latinTokens(text)) allowed.add(token.toLowerCase())
  // ISO 周号（2026-W44）里的 W44
  allowed.add(String(facts.week).split('-')[1].toLowerCase())
  return allowed
}

/**
 * 反向核对：输出里的拉丁词必须在允许集合里。
 * 返回 {ok, unknown:[{token, count}]}。
 */
export function checkVocabulary(body, allowed) {
  const counter = new Map()
  for (const token of latinTokens(stripCodeSpans(body))) {
    const key = token.toLowerCase()
    if (allowed.has(key)) continue
    if (/^w\d{1,2}$/.test(key)) continue
    counter.set(token, (counter.get(token) ?? 0) + 1)
  }
  const unknown = [...counter.entries()]
    .map(([token, count]) => ({ token, count }))
    .sort((a, b) => b.count - a.count || a.token.localeCompare(b.token))
  return { ok: unknown.length === 0, unknown }
}

function stripCodeSpans(text) {
  return String(text ?? '').replace(/`[^`]*`/g, ' ')
}

/**
 * thread 链条形状的软校验（只报警，不阻断）：
 * 每个 ### 事项应恰好有 起因 / 本周变化 / 当前状态 / 下一步 各一条，且顺序如此。
 * 为什么软：重复一条「本周变化」不影响事实正确性，硬失败会让一次成功合成白跑。
 */
export function checkThreadShape(body) {
  const threads = splitByHeading(String(body ?? ''), 3)
  const warnings = []
  const wanted = ['起因', '本周变化', '当前状态', '下一步']
  for (const thread of threads) {
    const labels = []
    for (const line of thread.body.split(/\r?\n/)) {
      const m = /^\s*-\s*(起因|本周变化|当前状态|下一步)[：:]/.exec(line)
      if (m) labels.push(m[1])
    }
    if (!labels.length) {
      warnings.push(`${thread.title}: 没有 起因/本周变化/当前状态/下一步 任一字段`)
      continue
    }
    for (const want of wanted) {
      const count = labels.filter((l) => l === want).length
      if (count === 0) warnings.push(`${thread.title}: 缺「${want}」`)
      else if (count > 1) warnings.push(`${thread.title}: 「${want}」出现 ${count} 次`)
    }
    const order = labels.filter((l, i) => i === 0 || l !== labels[i - 1])
    if (order.join('>') !== wanted.join('>')) {
      warnings.push(`${thread.title}: 字段顺序为 ${order.join('→')}，期望 ${wanted.join('→')}`)
    }
  }
  return { ok: warnings.length === 0, warnings }
}

/** 中文术语/引号术语的抽查（不阻断，只报告）。 */
export function quotedTerms(body) {
  const terms = new Set()
  const patterns = [/[「『]([^」』]{2,20})[」』]/g, /[“"]([^”"]{2,20})[”"]/g]
  for (const re of patterns) {
    for (const m of String(body ?? '').matchAll(re)) terms.add(m[1].trim())
  }
  return [...terms]
}

// ---------------------------------------------------------------------------
// prompt 正文
// ---------------------------------------------------------------------------

export const RULES = `1. thread 链条：同一件事跨天合并成「起因 → 本周变化 → 当前状态 → 下一步」，
   一条链只讲一件事；不按天写流水账。
2. 词汇复用：只允许使用下面 facts 里出现过的术语与短语（英文词/缩写/文件名/路径/指标名照抄，
   不造新词、不缩写、不改写同义词）；无法用原词表达时用中性中文描述，不要引入新缩写。
3. 引用：每条结论后面附日期（如 10-27）或 [[wikilink]]；引不出来的结论不要写。
   日期只能用 facts 里出现过的日期；路径与文件名必须从 facts 里整条逐字复制，
   不要拼接或缩写路径片段（例：不要拼出 sleep/ingest 这类片段，要么整条照抄 facts 里的路径，要么不写路径）。
4. 只写有证据的：facts 里没有的细节不补；缺失日不编造内容（确需说明某天没记录时只写「无记录」）。
5. 章节结构固定为下面 4 个二级标题，不增删、不改名、不调整顺序；不要写「趋势」「数据口径」两节（脚本生成）。
6. 术语表的英文术语必须逐字照抄；拿不准的不要写。`

/** 输出格式说明（模型只写这 4 节）。 */
export const OUTPUT_SPEC = `## 本周一句话
<1–2 句，概括这一周真正推动的一条主线；只写有证据的结论，带日期或 wikilink>

## 进展（按项目 / 任务）
### <thread 名：用 facts 里出现过的原词，不要造新标签>
- 起因：<这件事最早从哪天/哪条记录开始，带日期>
- 本周变化：<本周内实际发生了什么变化，带日期或 [[wikilink]]>
- 当前状态：<现在处于哪一步：已落地 / 未提交 / pending / 未发出 …，用原词>
- 下一步：<记录里写明的下一步；没写就写「无记录」>

## 反复出现的 blocker
- <blocker 原词>：出现 <N> 天（<10-26 / 10-27>），依据 [[<日期>]]
（facts.blockerRecurrence 为空时，整节只写一行：本周无跨天重复的 blocker。）

## 未闭环
- <未完成/未提交/待发/待确认的事，每条带日期或 wikilink>
（没有就写：本周记录中没有未闭环项。）`

/** 组装 prompt。 */
export function buildPrompt(facts) {
  const compact = factsForPrompt(facts)
  const allowed = [...buildVocabulary(facts)].sort()
  const vocabList = allowed.join(' ')
  return `你是个人知识库（Obsidian vault）的「Routine 周报合成器」。任务：把 ${facts.week}（${facts.start} 至 ${facts.end}）的 Dream 日报、journal、ingest、git 与任务事实，合成一篇周报正文。

"""下面 facts 是唯一事实来源；不要引入 facts 之外的任何事实、日期或术语。"""

【硬性规则】
${RULES}

【输出格式】严格按下面 4 节输出 markdown（不带一级标题，不带代码围栏，不要任何解释性开场/收尾）：
${OUTPUT_SPEC}

【术语表（输出中允许出现的英文术语，逐字照抄）】
${vocabList}

【facts（JSON）】
${JSON.stringify(compact, null, 1)}
`
}

/**
 * 校验失败后的纠正提示：把失败项回灌一次，重试一版（只重试一次，避免无限烧钱）。
 */
export function buildCorrectivePrompt(basePrompt, failure) {
  const lines = ['', '', '【上一版没有通过校验，请重写全文，只输出正文】']
  if (failure.structural && !failure.structural.ok) {
    lines.push(`- 结构问题：${failure.structural.errors.join('；')}`)
  }
  if (failure.vocab && !failure.vocab.ok) {
    lines.push(
      `- 输入外术语（删除，或换成术语表里的原词；不要拼接路径片段）：${failure.vocab.unknown
        .map((u) => u.token)
        .join('、')}`,
    )
  }
  if (failure.citations && !failure.citations.ok) {
    lines.push(`- facts 里没有的日期（删掉，或改成 facts 里出现过的日期）：${failure.citations.unknown.join('、')}`)
  }
  lines.push('- 严格按 4 个二级章节输出 markdown，不要开场白、不要解释、不要代码围栏。')
  return basePrompt + lines.join('\n') + '\n'
}

/** 只是给 --dry-run / 调试看的摘要。 */
export function describePrompt(prompt) {
  return {
    chars: prompt.length,
    lines: prompt.split('\n').length,
    sections: REQUIRED_SECTIONS,
    head: prompt.slice(0, 400),
  }
}
