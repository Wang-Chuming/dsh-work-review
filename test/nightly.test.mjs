/**
 * nightly.js 自检：写盘、幂等、dry-run、外来文件保护。
 * 跑法：node --test test/
 *
 * 每个用例都在临时目录里复制一份 fixture vault，绝不写仓库内的 fixtures。
 */
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { main } from '../lib/nightly.js'

const FIXTURE = fileURLToPath(new URL('./fixtures/vault/', import.meta.url))

function makeVault() {
  const dir = mkdtempSync(join(tmpdir(), 'wr-nightly-'))
  cpSync(FIXTURE, dir, { recursive: true })
  return dir
}

const VALID_BODY = `## 昨日总结

2026-10-28 无活动记录。

### 无

- 结果：无。
- 依据：journal 缺失。
- 边界／下一步：无。

#### Task 更新计划 · T1
- 文件：\`life/tasks/修复周报幂等.md\`
- 当前：\`本周在做\`
- 建议：\`本周在做\`
- 拟追加进度：无变化。
- 依据：fixture。
- 自动批准：常规

## Git commit plan

本日无提交计划。

## 今日重点任务

### 1. 收尾
- 对应：\`life/tasks/修复周报幂等.md\`
- 优先理由：发布前收尾。
- 今天第一步：跑测试。
- 算有进展：全绿。

### 2. 文案
- 对应：\`life/tasks/整理插件发布清单.md\`
- 优先理由：清单最后一项。
- 今天第一步：读 locale。
- 算有进展：差异入账。
`

test('nightly：--no-llm 写入 new dream，重跑幂等不重写', async () => {
  const vault = makeVault()
  const target = join(vault, 'life', 'dreams', '2026-10-28.md')

  assert.equal(await main(['--date', '2026-10-28', '--vault', vault, '--no-llm', '--quiet']), 0)
  assert.equal(existsSync(target), true)
  const first = readFileSync(target, 'utf8')
  assert.match(first, /<!-- work-review:dream:generated -->/)

  assert.equal(await main(['--date', '2026-10-28', '--vault', vault, '--no-llm', '--quiet']), 0)
  assert.equal(readFileSync(target, 'utf8'), first)
})

test('nightly：dry-run 不写文件', async () => {
  const vault = makeVault()
  const target = join(vault, 'life', 'dreams', '2026-10-29.md')
  assert.equal(await main(['--date', '2026-10-29', '--vault', vault, '--dry-run', '--quiet']), 0)
  assert.equal(existsSync(target), false)
})

test('nightly：已有非本工具的早报时拒绝覆盖，--force 才写', async () => {
  const vault = makeVault()
  const target = join(vault, 'life', 'dreams', '2026-10-26.md')
  const original = readFileSync(target, 'utf8')
  assert.equal(await main(['--date', '2026-10-26', '--vault', vault, '--no-llm', '--quiet']), 2)
  assert.equal(readFileSync(target, 'utf8'), original)

  assert.equal(
    await main(['--date', '2026-10-26', '--vault', vault, '--no-llm', '--force', '--quiet']),
    0,
  )
  assert.match(readFileSync(target, 'utf8'), /<!-- work-review:dream:generated -->/)
})

test('nightly：--body-file 走校验并写入计划计数', async () => {
  const vault = makeVault()
  const bodyFile = join(mkdtempSync(join(tmpdir(), 'wr-body-')), 'body.md')
  writeFileSync(bodyFile, VALID_BODY)
  const target = join(vault, 'life', 'dreams', '2026-10-28.md')
  assert.equal(
    await main(['--date', '2026-10-28', '--vault', vault, '--body-file', bodyFile, '--quiet']),
    0,
  )
  assert.match(readFileSync(target, 'utf8'), /#### Task 更新计划 · T1/)
})

test('nightly：--body-file 校验失败返回 3、不写文件', async () => {
  const vault = makeVault()
  const bodyFile = join(mkdtempSync(join(tmpdir(), 'wr-body-')), 'bad.md')
  writeFileSync(bodyFile, '## 昨日总结\n\n没有成果块也没有依据。\n')
  const target = join(vault, 'life', 'dreams', '2026-10-28.md')
  assert.equal(
    await main(['--date', '2026-10-28', '--vault', vault, '--body-file', bodyFile, '--quiet']),
    3,
  )
  assert.equal(existsSync(target), false)
})

test('nightly：保留生成块之后的手写区', async () => {
  const vault = makeVault()
  const target = join(vault, 'life', 'dreams', '2026-10-28.md')
  await main(['--date', '2026-10-28', '--vault', vault, '--no-llm', '--quiet'])
  const withHand = `${readFileSync(target, 'utf8')}\n## 手写补充\n\n保留我。\n`
  writeFileSync(target, withHand)
  // 加一条手写内容后，哈希不变 → 直接返回「未变化」，手写区自然保留。
  assert.equal(await main(['--date', '2026-10-28', '--vault', vault, '--no-llm', '--quiet']), 0)
  assert.match(readFileSync(target, 'utf8'), /保留我/)
})
