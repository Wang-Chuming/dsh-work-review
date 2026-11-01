/**
 * daily.js 自检：日期口径、05:00 窗口、fixture vault 上的事实收集。
 * 跑法：node --test test/
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  DAY_START_HOUR,
  buildDailyFacts,
  collectOpenTasks,
  dayWindow,
  resolveDateSpec,
} from '../lib/daily.js'

const VAULT = fileURLToPath(new URL('./fixtures/vault/', import.meta.url))

test('resolveDateSpec：today / yesterday / 绝对日期 / 负偏移', () => {
  const today = '2026-10-28'
  assert.equal(resolveDateSpec('today', today), '2026-10-28')
  assert.equal(resolveDateSpec('yesterday', today), '2026-10-27')
  assert.equal(resolveDateSpec('', today), '2026-10-27')
  assert.equal(resolveDateSpec('-1', today), '2026-10-27')
  assert.equal(resolveDateSpec('-3', today), '2026-10-25')
  assert.equal(resolveDateSpec('2026-10-20', today), '2026-10-20')
  assert.throws(() => resolveDateSpec('next-week', today), /无法识别的日期/)
})

test('dayWindow：默认 05:00 → 次日 05:00，可改起点', () => {
  const w = dayWindow('2026-10-28')
  assert.match(w.start, /^2026-10-28T05:00:00/)
  assert.match(w.end, /^2026-10-29T05:00:00/)
  assert.equal(w.dayStartHour, DAY_START_HOUR)

  const midnight = dayWindow('2026-10-28', 0)
  assert.match(midnight.start, /^2026-10-28T00:00:00/)
  assert.match(midnight.end, /^2026-10-29T00:00:00/)

  assert.equal(dayWindow('2026-10-28', 99).dayStartHour, 23)
})

test('buildDailyFacts：读到 fixture 的 journal / ingest / 未关闭任务', () => {
  const facts = buildDailyFacts({ vaultRoot: VAULT, date: '2026-10-26', today: '2026-10-28', withGit: false })
  assert.equal(facts.date, '2026-10-26')
  assert.equal(facts.weekdayLabel, '周一')
  assert.equal(facts.missing.journal, false)
  assert.equal(facts.journal.progress.length, 3)
  assert.equal(facts.journal.blockers.length, 3)
  assert.equal(facts.ingest.proposals, 2)
  assert.equal(facts.ingest.writtenBack, 2)
  assert.equal(facts.git.available, false)
  assert.deepEqual(facts.missing, { journal: false, ingest: false, dream: false })
})

test('buildDailyFacts：缺失的日子不编造数据', () => {
  const facts = buildDailyFacts({ vaultRoot: VAULT, date: '2026-10-28', today: '2026-10-28', withGit: false })
  assert.equal(facts.journal, null)
  assert.equal(facts.ingest, null)
  assert.deepEqual(facts.missing, { journal: true, ingest: true, dream: true })
})

test('collectOpenTasks：过滤已关闭状态，按 updated 倒序', () => {
  const tasks = collectOpenTasks(VAULT)
  const names = tasks.map((t) => t.task)
  assert.ok(names.includes('修复周报幂等'))
  assert.ok(names.includes('整理插件发布清单'))
  for (let i = 1; i < tasks.length; i += 1) {
    assert.ok(tasks[i - 1].updated >= tasks[i].updated, 'updated 应倒序')
  }
  assert.ok(tasks.every((t) => t.status && !/完成|归档/.test(t.status)))
})
