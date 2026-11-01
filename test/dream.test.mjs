/**
 * dream.js 自检：prompt 契约、校验规则、幂等渲染。
 * 跑法：node --test test/
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { buildDailyFacts } from '../lib/daily.js'
import {
  DREAM_END_MARKER,
  DREAM_MARKER,
  buildDreamCorrectivePrompt,
  buildDreamPrompt,
  computeDreamHash,
  existingDreamHash,
  normalizeDreamOutput,
  renderDreamFile,
  renderDreamSkeleton,
  validateDreamBody,
} from '../lib/dream.js'

const VAULT = fileURLToPath(new URL('./fixtures/vault/', import.meta.url))

function factsOf(date = '2026-10-28') {
  return buildDailyFacts({ vaultRoot: VAULT, date, today: '2026-10-28', withGit: false })
}

/** 一份能通过校验的最小早报正文。 */
function validBody(date = '2026-10-28') {
  return `## 昨日总结

${date} 完成两件事，提交 0 笔（vault 不是 git 仓库）。

### 修好幂等

- 结果：重跑不再覆盖手写区，回归用例 3 条通过。
- 依据：journal「幂等」段；\`lib/core.js\`。
- 边界／下一步：跨平台路径待验证。

#### Task 更新计划 · T1
- 文件：\`life/tasks/修复周报幂等.md\`
- 当前：\`本周在做\`
- 建议：\`本周在做\`
- 拟追加进度：回归用例补齐，手写区保留。
- 依据：journal「幂等」段。
- 自动批准：常规

#### 新任务建议 · T2
- 标题：补跨平台回归用例
- area：\`tools\`
- 初始状态：\`排队中\`
- 详情：在 fixture 上固定 today，覆盖跨平台路径。
- 依据：journal「幂等」段。
- 自动批准：升级（原因：新增测试依赖，需要人工确认。）

## Git commit plan

本日无提交计划。

## 今日重点任务

### 1. 补跨平台回归
- 对应：\`life/tasks/修复周报幂等.md\`
- 优先理由：发布前唯一阻塞项。
- 今天第一步：列出 Windows 路径分支。
- 算有进展：新增一条断言。

### 2. 收尾文案
- 对应：\`life/tasks/整理插件发布清单.md\`
- 优先理由：发布清单最后一项。
- 今天第一步：读 locale 两套文件。
- 算有进展：差异清单写进任务进度。
`
}

test('buildDreamPrompt：带日期、事实 JSON 与输出契约', () => {
  const facts = factsOf()
  const prompt = buildDreamPrompt(facts)
  assert.match(prompt, /2026-10-28/)
  assert.match(prompt, /## 昨日总结/)
  assert.match(prompt, /Git commit plan/)
  assert.match(prompt, /自动批准/)
  assert.match(prompt, /"openTasks"|"tasks"/)
  assert.ok(prompt.length > 1500)
})

test('buildDreamCorrectivePrompt：列出失败项并要求重输', () => {
  const prompt = buildDreamCorrectivePrompt('BASE', { errors: ['缺少章节：## 昨日总结'] })
  assert.match(prompt, /BASE/)
  assert.match(prompt, /缺少章节/)
})

test('validateDreamBody：合法输出通过', () => {
  const result = validateDreamBody(validBody(), factsOf())
  assert.equal(result.ok, true, result.errors.join('；'))
  assert.equal(result.counts.taskPlans, 2)
  assert.equal(result.counts.focus, 2)
})

test('validateDreamBody：缺少章节 / 编号断档 / 自动批准非法 / 缺字段都要拦', () => {
  const facts = factsOf()

  const noSection = validBody().replace('## Git commit plan', '## 提交计划')
  assert.equal(validateDreamBody(noSection, facts).ok, false)

  const gap = validBody().replace('#### Task 更新计划 · T1', '#### Task 更新计划 · T3')
  const gapResult = validateDreamBody(gap, facts)
  assert.equal(gapResult.ok, false)
  assert.ok(gapResult.errors.some((e) => /编号不连续/.test(e)))

  const badApproval = validBody().replace('- 自动批准：常规', '- 自动批准：也许可以')
  const badResult = validateDreamBody(badApproval, facts)
  assert.equal(badResult.ok, false)
  assert.ok(badResult.errors.some((e) => /自动批准/.test(e)))

  const noFile = validBody().replace('- 文件：`life/tasks/修复周报幂等.md`', '')
  assert.ok(validateDreamBody(noFile, facts).errors.some((e) => /缺少「- 文件：」/.test(e)))

  const noResult = validBody().replace('- 结果：重跑不再覆盖手写区，回归用例 3 条通过。', '')
  assert.ok(validateDreamBody(noResult, facts).errors.some((e) => /缺少「- 结果：」/.test(e)))
})

test('computeDreamHash：同 facts 稳定，facts 变则变', () => {
  const a = computeDreamHash(factsOf(), 'synthesized')
  assert.equal(a, computeDreamHash(factsOf(), 'synthesized'))
  assert.notEqual(a, computeDreamHash(factsOf(), 'no-llm'))
  const other = factsOf('2026-10-26')
  assert.notEqual(a, computeDreamHash(other, 'synthesized'))
})

test('renderDreamFile：新文件有 frontmatter + 生成块，重跑保留手写区', () => {
  const facts = factsOf()
  const first = renderDreamFile(facts, validBody(), 'deadbeef')
  assert.match(first, /^---\ntype: dream/)
  assert.ok(first.includes(DREAM_MARKER))
  assert.ok(first.includes(DREAM_END_MARKER))
  assert.equal(existingDreamHash(first), 'deadbeef')

  const withHand = `${first}\n## 我自己的补充\n\n不要覆盖这一段。\n`
  const second = renderDreamFile(facts, '## 昨日总结\n\n新版本。', 'cafebabe', withHand)
  assert.equal(existingDreamHash(second), 'cafebabe')
  assert.match(second, /不要覆盖这一段/)
  assert.ok(!second.includes('重跑不再覆盖手写区，回归用例'))
})

test('renderDreamSkeleton：确定性正文覆盖三节且不冒充合成', () => {
  const body = renderDreamSkeleton(factsOf())
  assert.match(body, /## 昨日总结/)
  assert.match(body, /## Git commit plan/)
  assert.match(body, /## 今日重点任务/)
  assert.match(body, /--no-llm/)
})

test('normalizeDreamOutput：去围栏、H1 与开场白', () => {
  const raw = '好的，下面是早报：\n\n```markdown\n# 标题\n\n## 昨日总结\n\n内容\n```'
  const cleaned = normalizeDreamOutput(raw)
  assert.equal(cleaned.startsWith('## 昨日总结'), true)
  assert.ok(!cleaned.includes('```'))
})
