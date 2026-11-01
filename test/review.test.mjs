/**
 * review.js 自检：计划分类、prompt、agent 结果解析、审批块渲染。
 * 跑法：node --test test/
 *
 * 用 fixture 的 2026-10-26 早报（T1–T4 / G1–G4，其中 G3 标了升级）做真实输入，
 * 不启动任何模型。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import * as core from '../lib/core.js'
import { buildDailyFacts } from '../lib/daily.js'
import {
  applyReviewBlock,
  buildReviewPrompt,
  classifyPlans,
  extractAgentResult,
  renderReviewBullets,
} from '../lib/review.js'

const VAULT = fileURLToPath(new URL('./fixtures/vault/', import.meta.url))
const DREAM_TEXT = readFileSync(new URL('./fixtures/vault/life/dreams/2026-10-26.md', import.meta.url), 'utf8')

function fixtureDream() {
  return core.parseDream(DREAM_TEXT)
}

function fixtureFacts() {
  const facts = buildDailyFacts({ vaultRoot: VAULT, date: '2026-10-26', today: '2026-10-28', withGit: false })
  facts.vaultRoot = VAULT
  return facts
}

test('classifyPlans：常规进 approved，升级/缺失/无编号进 escalated', () => {
  const { approved, escalated } = classifyPlans(fixtureDream())
  assert.deepEqual(approved.map((a) => a.id), ['T1', 'T2', 'T3', 'T4', 'G1', 'G2', 'G4'])
  assert.deepEqual(escalated.map((e) => e.id), ['G3'])
  assert.match(escalated[0].reason, /fixture/)

  const mixed = classifyPlans({
    taskPlans: [
      { id: 'T1', kind: 'task-update', title: 'a', approval: '常规' },
      { id: 'T2', kind: 'task-update', title: 'b', approval: '' },
      { id: 'T3', kind: 'task-update', title: 'c', approval: '有争议' },
      { id: '', kind: 'task-update', title: 'd', approval: '常规' },
    ],
    gitPlans: [],
  })
  assert.deepEqual(mixed.approved.map((a) => a.id), ['T1'])
  assert.deepEqual(mixed.escalated.map((e) => e.id), ['T2', 'T3', ''])
  assert.match(mixed.escalated[0].reason, /未写自动批准/)
})

test('buildReviewPrompt：只列 approved，写死只读/写入边界与 JSON 输出', () => {
  const dream = fixtureDream()
  const { approved, escalated } = classifyPlans(dream)
  const prompt = buildReviewPrompt({
    facts: fixtureFacts(),
    dream,
    approved,
    escalated,
    live: false,
  })
  assert.match(prompt, /read-only/)
  assert.match(prompt, /绝不 push/)
  assert.match(prompt, /"items"/)
  // approved / escalated 是两个独立列表：G3 只在 escalated 里出现。
  const approvedPart = /"approved": (\[[\s\S]*?\]),\n  "escalated"/.exec(prompt)?.[1] ?? ''
  const escalatedPart = /"escalated": (\[[\s\S]*?\]),\n  "currentStatus"/.exec(prompt)?.[1] ?? ''
  assert.match(approvedPart, /"T1"/)
  assert.match(approvedPart, /"G1"/)
  assert.ok(!approvedPart.includes('"G3"'), '升级项不应出现在 approved 列表')
  assert.match(escalatedPart, /"G3"/)

  const livePrompt = buildReviewPrompt({
    facts: fixtureFacts(),
    dream,
    approved,
    escalated,
    live: true,
  })
  assert.match(livePrompt, /workspace-write/)
})

test('extractAgentResult：带围栏 / 裸 JSON / 无效输出', () => {
  const fenced = '做了事。\n\n```json\n{"items":[{"id":"T1","verdict":"done","note":"ok"}]}\n```\n'
  assert.deepEqual(extractAgentResult(fenced).items[0].id, 'T1')

  const lastWins = '```json\n{"items":[]}\n```\n后来：\n```json\n{"items":[{"id":"G1","verdict":"skipped"}]}\n```'
  assert.equal(extractAgentResult(lastWins).items[0].id, 'G1')

  const bare = '结果如下：{"items":[{"id":"T2","verdict":"failed"}],"notes":"x"}'
  assert.equal(extractAgentResult(bare).notes, 'x')

  assert.equal(extractAgentResult('没有任何 JSON'), null)
  assert.equal(extractAgentResult(''), null)
})

test('renderReviewBullets：parseReviewBlock 能读回 done / pending / escalated', () => {
  const review = {
    items: [
      { id: 'T1', verdict: 'done', note: '追加进度 1 行', commit: null },
      { id: 'G1', verdict: 'done', note: '提交 2 个路径', commit: 'abc1234' },
      { id: 'G2', verdict: 'skipped', note: '前置条件未满足' },
      { id: 'G4', verdict: 'failed', note: '上下文不够' },
    ],
    escalated: [{ id: 'G3', reason: '新增 fixture 需要脱敏确认' }],
    notes: '三条执行，一条跳过。',
  }
  const bullets = renderReviewBullets(review, { date: '2026-10-26', time: '2026-10-27 05:10' })
  assert.match(bullets, /审查通过 · T1 · 执行：/)
  assert.match(bullets, /提交：`abc1234`/)
  assert.match(bullets, /升级（原因：新增 fixture 需要脱敏确认）/)
  assert.match(bullets, /未通过 · G4/)

  const parsed = core.parseReviewBlock(bullets)
  assert.deepEqual(parsed.done.sort(), ['G1', 'T1'])
  assert.deepEqual(parsed.pending.sort(), ['G2', 'G3', 'G4'])
  assert.ok(parsed.entries.some((e) => e.escalated && e.ids.includes('G3')))
})

test('applyReviewBlock：有标记就替换，没有就追加一节', () => {
  const journal = '---\ntype: journal\n---\n\n# 2026-10-26\n\n<!-- sleep:begin -->\n## Sleep\n<!-- sleep:end -->\n'
  const once = applyReviewBlock(journal, '- 2026-10-26 05:10 审查通过 · T1 · 执行：ok')
  assert.match(once, /<!-- sleep-review:begin -->/)
  assert.equal((once.match(/## 自动审批/g) ?? []).length, 1)

  const twice = applyReviewBlock(once, '- 2026-10-26 06:00 审查通过 · T2 · 执行：ok')
  assert.equal((twice.match(/<!-- sleep-review:begin -->/g) ?? []).length, 1)
  assert.ok(!twice.includes('T1 · 执行：ok'))
  assert.ok(twice.includes('T2 · 执行：ok'))
})

test('parseDream 与 review 计划对齐：T/G 编号来自早报本身', () => {
  const dream = fixtureDream()
  assert.deepEqual(dream.taskPlans.map((p) => p.id), ['T1', 'T2', 'T3', 'T4'])
  assert.deepEqual(dream.gitPlans.map((p) => p.id), ['G1', 'G2', 'G3', 'G4'])
  assert.equal(dream.focus.length, 3)
})
