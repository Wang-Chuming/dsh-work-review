/**
 * dream.js — 每日早报（Dream）的 prompt、校验与幂等渲染。
 *
 * 早报是自动化流程里「模型负责判断、脚本负责记账」的那一半：
 *
 *   facts(daily.js) → prompt → `dsh --profile headless` → 校验 → 写 life/dreams/<date>.md
 *
 * 输出契约与面板/审批保持一致：`## 昨日总结`（含 `###` 成果块与 `#### Task 更新
 * 计划 · Tn` / `#### 新任务建议 · Tn`）、`## Git commit plan`（`### Gn`）、
 * `## 今日重点任务`（`### 1.`）。core.parseDream 能直接读回这些块，review.js 也
 * 就按 T/G 编号执行审批——**编号是脚本与模型之间唯一的接口**。
 *
 * 生成块用 `<!-- work-review:dream:* -->` 标记包起来：重跑只替换块内内容，块
 * 之后的手写区原样保留；facts 哈希没变就跳过模型，天然幂等。
 */

import {
  section,
  splitByHeading,
  stripLeadingH1,
} from './core.js'
import { dailyFactsText } from './daily.js'

/** 生成块起止标记；与周报的 sleep-routine 标记互不干扰。 */
export const DREAM_MARKER = '<!-- work-review:dream:generated -->'
export const DREAM_END_MARKER = '<!-- work-review:dream:generated:end -->'
export const DREAM_HASH_PREFIX = '<!-- work-review:dream:facts-hash:'

/** prompt 版本；改动规则时递增，使 facts 哈希变化、触发重新合成。 */
export const DREAM_PROMPT_VERSION = 'dream-v1'

/** 校验通过所必需的三个二级章节（顺序固定）。 */
export const DREAM_SECTIONS = ['昨日总结', 'Git commit plan', '今日重点任务']

/** 自动审批的两个取值；其余一律视为升级。 */
const ROUTINE = /^常规/
const ESCALATED = /^升级/

function clip(text, max) {
  const s = String(text ?? '').trim()
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

// ---------------------------------------------------------------------------
// prompt
// ---------------------------------------------------------------------------

/**
 * facts → prompt。规则写成可核对的条件，而不是形容词：
 * 引用必须带 sha / 文件路径，编号必须连续，自动批准只有两种取值。
 */
export function buildDreamPrompt(facts) {
  const data = dailyFactsText(facts, { taskLimit: 10 })
  const date = facts.date
  const nextDay = facts.window.end.slice(0, 10)

  return `你在为 Obsidian 风格的 vault 写一份 ${date}（${facts.weekdayLabel}）的早报（Dream）。
早报的读者是作者本人，第二天早上看；它同时是自动化审批的输入——后面有一个脚本会
按你写下的 T/G 编号逐条执行，所以你只能写你从事实里能证明的东西。

## 事实（唯一允许的信息来源）

\`\`\`json
${data}
\`\`\`

时间窗口：${facts.window.start} → ${facts.window.end}（本地时区）。
journal：${facts.sources.journal ?? '（缺失）'}
ingest：${facts.sources.ingest ?? '（缺失）'}
已有早报：${facts.sources.dream ?? '（无，本次新建）'}

## 输出契约

只输出 markdown，从第一个 \`## 昨日总结\` 开始，**不要**输出 H1 标题、不要代码围栏、
不要开场白和结束语。三个二级章节按顺序出现，一个都不能少：

\`\`\`markdown
## 昨日总结

<总览段落：≤200 字，引用 journal 的 Progress 与 git commit 的数量/sha；没有活动就直说>

### <成果标题>
- 结果：<发生了什么，带数字或路径>
- 依据：<commit sha / 文件路径 / journal 里的原句片段>
- 边界／下一步：<未完成的部分；没有就写「无」>

#### Task 更新计划 · T1
- 文件：\`life/tasks/<文件名>.md\`
- 当前：\`<状态>\`
- 建议：\`<状态>\`
- 拟追加进度：<要追加到该任务 \`## 进度\` 的一段话>
- 依据：<上面的事实>
- 自动批准：常规

#### 新任务建议 · T2
- 标题：<任务标题>
- area：\`<分域>\`
- 初始状态：\`<状态>\`
- 详情：<为什么值得单独建一条>
- 依据：<上面的事实>
- 自动批准：常规

入库候选：[[life/notes/ingest/${date}]]（N 条；已写回 M 条）

## Git commit plan

<一句话总览：这次计划提交什么、为什么>

### G1 · <组标题>
- 仓库：\`<vault 绝对路径或 "vault">\`
- 对应成果：<上面某个成果标题>
- 纳入：\`<路径1>\`、\`<路径2>\`
- 不纳入：\`<明确排除的路径，没有就写「无」>\`
- commit message：\`<type(scope): subject>\`
- 前置条件：<需要先发生什么；没有就写「无」>
- 自动批准：常规

## 今日重点任务

### 1. <标题>
- 对应：\`<life/tasks/... 或成果>\`
- 优先理由：<为什么是今天>
- 今天第一步：<一个可立刻执行的动作>
- 算有进展：<完成到什么程度算推进>
\`\`\`

## 硬性规则

1. **不编事实。** 数字、sha、文件路径只能来自上面的事实 JSON；事实里没有就写「无记录」。
2. **编号连续。** T 编号从 T1 开始、跨「Task 更新计划」和「新任务建议」两种块连续递增；
   G 编号从 G1 开始连续递增。不要跳号、不要复用。
3. **自动批准只有两种取值。** 常规：改任务状态/追加进度、按已列路径提交、写 journal；
   升级（原因：…）：改规则源（AGENTS/SCHEMA/ARCHITECTURE/.specs/scripts）、删除/归档、
   push/pull/sync、动无关文件、语义不确定。拿不准就写升级。
4. **Git plan 只列你自己能逐条列明的路径。** 「纳入」必须是具体文件路径；整目录提交、
   \`git add -A\`、cleanup 都不允许出现在计划里。push 永远不在自动批准范围。
5. **今日重点任务 2–5 条**，从上面「未关闭任务」里选，按优先级排序；优先级理由要具体。
6. 语言中文；引用术语时保持原文（用反引号）；不要写「赋能」「闭环」这类空词。
7. 如果事实显示这一天确实没有任何活动：昨日总结写成「本日无可总结的活动」+ 一句原因，
   Git commit plan 写「### G0 · 无」以外的形式（直接写「本日无提交计划」），
   今日重点任务照常从任务列表选 2–5 条。

日期范围：只会涉及 ${date} 与 ${nextDay}（窗口边界）；其他日期一律不要出现。`
}

/** 校验失败后的重试 prompt：带上失败项，要求只修这些。 */
export function buildDreamCorrectivePrompt(basePrompt, { errors = [], warnings = [] } = {}) {
  const list = [...errors.map((e) => `- 错误：${e}`), ...warnings.map((w) => `- 告警：${w}`)]
  return `${basePrompt}

---

上一次输出没有通过校验，逐条修掉下面这些问题后**重新输出完整早报**（不要解释、不要只给差异）：

${list.join('\n')}`
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

/** 从「#### Task 更新计划 · T1」这类四级标题里收集编号。 */
function planIds(markdown) {
  const ids = []
  for (const m of String(markdown).matchAll(/^####\s+(?:Task 更新计划|新任务建议)\s*·\s*([TG]\d+)/gm)) {
    ids.push(m[1])
  }
  return ids
}

/** Git plan 的编号来自「### G1 · 标题」。 */
function gitPlanIds(markdown) {
  const gitPart = section(String(markdown), 'Git commit plan', 2) ?? ''
  const ids = []
  for (const m of String(gitPart).matchAll(/^###\s*([G]\d+)\b/gm)) ids.push(m[1])
  return ids
}

function sequentialProblems(ids, letter) {
  const errors = []
  ids.forEach((id, index) => {
    const expected = `${letter}${index + 1}`
    if (id !== expected) errors.push(`编号不连续：第 ${index + 1} 个是 ${id}，应为 ${expected}`)
  })
  const seen = new Set()
  for (const id of ids) {
    if (seen.has(id)) errors.push(`编号重复：${id}`)
    seen.add(id)
  }
  return errors
}

/** 事实里出现过、允许被引用的日期集合。 */
function allowedDates(facts) {
  const set = new Set([facts.date, facts.window.end.slice(0, 10), facts.today])
  for (const c of facts.git?.commits ?? []) {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(c.time ?? '')
    if (m) set.add(m[1])
  }
  for (const t of facts.tasks ?? []) if (/^\d{4}-\d{2}-\d{2}$/.test(t.updated)) set.add(t.updated)
  return set
}

function hasActivity(facts) {
  return Boolean(
    (facts.git?.commits?.length ?? 0) > 0 ||
      (facts.journal?.progress?.length ?? 0) > 0 ||
      (facts.ingest?.writtenBack ?? 0) > 0 ||
      (facts.git?.dirty?.length ?? 0) > 0,
  )
}

/**
 * 校验模型输出。返回 {ok, errors, warnings, sections, counts}；
 * 错误会阻断写入（exit 3），告警只记日志。
 */
export function validateDreamBody(body, facts) {
  const errors = []
  const warnings = []
  const text = String(body ?? '')
  if (!text.trim()) return { ok: false, errors: ['正文为空'], warnings, sections: [], counts: {} }

  const present = splitByHeading(text, 2).map((s) => s.title.trim())
  const missing = DREAM_SECTIONS.filter((s) => !present.includes(s))
  for (const s of missing) errors.push(`缺少章节：## ${s}`)
  const ordered = DREAM_SECTIONS.filter((s) => present.includes(s))
  const actualOrder = present.filter((s) => ordered.includes(s))
  if (ordered.join('|') !== actualOrder.join('|')) {
    errors.push(`章节顺序不对：应为 ${DREAM_SECTIONS.join(' → ')}`)
  }
  if (present[0] !== '昨日总结') errors.push(`第一个二级章节必须是「昨日总结」，实际是「${present[0] ?? '无'}」`)

  // 昨日总结：成果块与必填字段
  const today = section(text, '昨日总结', 2) ?? ''
  const items = splitByHeading(today, 3).filter((s) => !/^Task 更新计划|^新任务建议/.test(s.title))
  const emptyDay = /本日无可总结的活动/.test(today)
  if (!hasActivity(facts) && emptyDay) {
    // 允许「无活动」的写法
  } else if (!items.length) {
    errors.push('「昨日总结」里没有 ### 成果块')
  } else {
    for (const item of items) {
      if (!/- 结果[:：]/.test(item.body)) errors.push(`成果「${clip(item.title, 20)}」缺少「- 结果：」`)
      if (!/- 依据[:：]/.test(item.body)) errors.push(`成果「${clip(item.title, 20)}」缺少「- 依据：」`)
    }
  }

  // T 计划：编号连续 + 自动批准取值合法
  const tIds = planIds(today)
  errors.push(...sequentialProblems(tIds, 'T'))
  const planBlocks = splitByHeading(today, 4).filter((s) => /^Task 更新计划|^新任务建议/.test(s.title))
  for (const block of planBlocks) {
    const label = clip(block.title.replace(/^Task 更新计划\s*·\s*|^新任务建议\s*·\s*/, ''), 20)
    if (!/- 自动批准[:：]\s*\S/.test(block.body)) {
      errors.push(`「${label}」缺少「- 自动批准：」`)
      continue
    }
    const approval = /- 自动批准[:：]\s*(.+)/.exec(block.body)?.[1]?.trim() ?? ''
    if (!ROUTINE.test(approval) && !ESCALATED.test(approval)) {
      errors.push(`「${label}」的自动批准只能是「常规」或「升级（原因：…）」，实际是「${approval}」`)
    }
    if (/^Task 更新计划/.test(block.title)) {
      if (!/- 文件[:：]/.test(block.body)) errors.push(`「${label}」缺少「- 文件：」`)
      if (!/- 建议[:：]/.test(block.body)) errors.push(`「${label}」缺少「- 建议：」`)
    } else if (!/- 标题[:：]/.test(block.body)) {
      errors.push(`「${label}」缺少「- 标题：」`)
    }
  }

  // G 计划：编号连续 + 纳入/commit message/自动批准
  const gitPart = section(text, 'Git commit plan', 2) ?? ''
  const gIds = gitPlanIds(text)
  errors.push(...sequentialProblems(gIds, 'G'))
  const gitBlocks = splitByHeading(gitPart, 3).filter((s) => /^G\d+\b/.test(s.title.trim()))
  for (const block of gitBlocks) {
    const label = clip(block.title, 20)
    if (!/- 纳入[:：]/.test(block.body)) errors.push(`「${label}」缺少「- 纳入：」`)
    if (!/- commit message[:：]/i.test(block.body)) errors.push(`「${label}」缺少「- commit message：」`)
    const approval = /- 自动批准[:：]\s*(.+)/.exec(block.body)?.[1]?.trim() ?? ''
    if (approval && !ROUTINE.test(approval) && !ESCALATED.test(approval)) {
      errors.push(`「${label}」的自动批准只能是「常规」或「升级（原因：…）」`)
    }
    if (/^- 自动批准/m.test(block.body) === false) warnings.push(`「${label}」没有写自动批准，审批时按升级处理`)
  }
  if (!gitBlocks.length && !/本日无提交计划|无提交计划/.test(gitPart)) {
    warnings.push('「Git commit plan」没有任何 G 块，也没有说明「本日无提交计划」')
  }

  // 今日重点任务
  const focusPart = section(text, '今日重点任务', 2) ?? ''
  const focusBlocks = splitByHeading(focusPart, 3).filter((s) => /^\d+[.、]/.test(s.title.trim()))
  if (focusBlocks.length < 2) warnings.push(`今日重点任务只有 ${focusBlocks.length} 条（建议 2–5 条）`)
  if (focusBlocks.length > 5) warnings.push(`今日重点任务有 ${focusBlocks.length} 条（建议 2–5 条）`)

  // 占位符与日期越界（告警即可：不因措辞阻断一次成功的合成）
  if (/<(路径|标题|状态|日期|sha|name)>|TODO|待填/.test(text)) warnings.push('正文里仍有占位符')
  const allowed = allowedDates(facts)
  const strayDates = new Set()
  for (const m of text.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)) {
    if (!allowed.has(m[1])) strayDates.add(m[1])
  }
  if (strayDates.size) warnings.push(`出现了事实外的日期：${[...strayDates].slice(0, 6).join(', ')}`)

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    sections: present,
    counts: { items: items.length, taskPlans: tIds.length, gitPlans: gIds.length, focus: focusBlocks.length },
  }
}

// ---------------------------------------------------------------------------
// 幂等渲染
// ---------------------------------------------------------------------------

/** prompt 版本 + 模式 + 事实包 → 哈希。同哈希重跑跳过模型。 */
export function computeDreamHash(facts, extra = '') {
  const payload = JSON.stringify({
    version: DREAM_PROMPT_VERSION,
    extra,
    date: facts.date,
    journal: facts.journal,
    ingest: facts.ingest,
    tasks: facts.tasks,
    git: facts.git.available ? { branch: facts.git.branch, commits: facts.git.commits, dirty: facts.git.dirty } : { available: false },
  })
  // node:crypto 只在写文件路径上用，同步 hash 足以做幂等判断。
  let h = 0
  for (let i = 0; i < payload.length; i += 1) h = (h * 31 + payload.charCodeAt(i)) | 0
  return Math.abs(h).toString(16).padStart(8, '0')
}

/** 已有文件里的 facts 哈希（没有就返回 null）。 */
export function existingDreamHash(text) {
  if (!text) return null
  const m = new RegExp(`${DREAM_HASH_PREFIX}([0-9a-f]+)\\s*-->`).exec(text)
  return m ? m[1] : null
}

/** 生成块之后的全部内容（手写区）。 */
function handSuffix(text) {
  if (!text) return ''
  const index = text.indexOf(DREAM_END_MARKER)
  if (index < 0) return ''
  return text.slice(index + DREAM_END_MARKER.length)
}

function renderFrontmatter(facts) {
  return [
    '---',
    'type: dream',
    'domain: life',
    `title: "Dream ${facts.date} 早报"`,
    `created: ${facts.date}`,
    `updated: ${facts.today}`,
    'status: draft',
    'tags:',
    '  - dream-report',
    '  - work-review',
    'related:',
    `  - "[[${facts.date}]]"`,
    '---',
    '',
  ].join('\n')
}

/** 确定性骨架（--no-llm）：不调模型、不假装有判断。 */
export function renderDreamSkeleton(facts) {
  const commits = facts.git?.available ? facts.git.commits : []
  const lines = []
  lines.push('## 昨日总结', '')
  lines.push('> 本节由脚本按事实列表生成（`--no-llm`，未经模型合成）。', '')
  lines.push(`- 提交：${commits.length} 笔${commits.length ? `（${commits.slice(0, 5).map((c) => `${c.sha} ${clip(c.msg, 60)}`).join('；')}）` : ''}`)
  lines.push(`- 脏文件：${facts.git?.available ? `${facts.git.dirty.length} 条` : '未知（vault 不是 git 仓库）'}`)
  if (facts.journal) {
    lines.push(`- Progress：${facts.journal.progress.length} 条`)
    lines.push(`- Blockers：${facts.journal.blockers.length} 条`)
  } else {
    lines.push('- journal：缺失')
  }
  if (facts.ingest) lines.push(`- 自动入库：${facts.ingest.proposals ?? '?'} 条，写回 ${facts.ingest.writtenBack} 条`)
  lines.push('', '## Git commit plan', '', '本日无提交计划（--no-llm 骨架不生成计划；请手动或重跑合成）。', '')
  lines.push('## 今日重点任务', '')
  if (!facts.tasks.length) {
    lines.push('无未关闭任务。')
  } else {
    facts.tasks.slice(0, 5).forEach((t, index) => {
      lines.push(`### ${index + 1}. ${t.task}`)
      lines.push(`- 对应：\`${t.path}\``)
      lines.push(`- 当前状态：\`${t.status}\``)
      lines.push('- 优先理由：（未合成）')
      lines.push('')
    })
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** 把正文包进生成块（含哈希）。 */
export function renderGeneratedBlock(body, hash) {
  return [
    DREAM_MARKER,
    body.trim(),
    '',
    `${DREAM_HASH_PREFIX}${hash} -->`,
    DREAM_END_MARKER,
  ].join('\n')
}

/**
 * 幂等写：已有文件 → 只换生成块、保留手写区与 frontmatter；
 * 新文件 → frontmatter + 生成块。
 */
export function renderDreamFile(facts, body, hash, existingText = null) {
  const block = renderGeneratedBlock(body, hash)
  if (!existingText || !existingText.includes(DREAM_MARKER)) {
    return `${renderFrontmatter(facts)}\n${block}\n`
  }
  const start = existingText.indexOf(DREAM_MARKER)
  const end = existingText.indexOf(DREAM_END_MARKER)
  const head = existingText.slice(0, start)
  const suffix = end >= 0 ? handSuffix(existingText) : ''
  return `${head}${block}${suffix}`
}

/** 去掉模型加的代码围栏 / H1 / 开场白，只留从第一个二级标题开始的部分。 */
export function normalizeDreamOutput(raw) {
  let text = String(raw ?? '').trim()
  const fence = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/.exec(text)
  if (fence) text = fence[1].trim()
  text = text.replace(/^\s*```(?:markdown|md)?\s*\n/, '').replace(/\n```\s*$/, '')
  text = stripLeadingH1(text)
  const firstH2 = text.search(/^##\s+/m)
  if (firstH2 > 0) text = text.slice(firstH2)
  return text.trim()
}
