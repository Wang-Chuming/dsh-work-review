/**
 * core/prompt 自检：日期口径、抽取、校验、幂等写。
 * 跑法：node --test test/
 *
 * 所有 facts 都来自仓库内自包含的 mini-vault（test/fixtures/vault/），
 * 不依赖任何作者本机目录；路径用 import.meta.url 计算，从任意 cwd 跑都成立。
 * Git 采集显式关闭（withGit: false），避免把测试绑到外层仓库的提交历史。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import * as core from '../lib/core.js'
import { buildPrompt, buildVocabulary, checkVocabulary, PROMPT_VERSION } from '../lib/prompt.js'

const VAULT = fileURLToPath(new URL('./fixtures/vault/', import.meta.url))

/** fixture facts：固定 vault、固定 today、不采集 git。 */
function buildFacts(week, today = '2026-10-28') {
  return core.buildFactsPack({ vaultRoot: VAULT, week, today, withGit: false })
}

test('ISO 周：W43/W44 边界', () => {
  assert.equal(core.isoWeekOf('2026-10-19').weekStr, '2026-W43')
  assert.equal(core.isoWeekOf('2026-10-25').weekStr, '2026-W43')
  assert.equal(core.isoWeekOf('2026-10-26').weekStr, '2026-W44')
  assert.equal(core.weekStart('2026-W43'), '2026-10-19')
  const range = core.weekRange('2026-W44')
  assert.equal(range.start, '2026-10-26')
  assert.equal(range.end, '2026-11-01')
  assert.equal(range.dates.length, 7)
})

test('--week last：周日的 last 是本周，其他日子是上一周', () => {
  // 2026-11-01 是周日 → last = W44
  assert.equal(core.resolveWeekSpec('last', '2026-11-01'), '2026-W44')
  // 2026-10-28 是周三 → last = W43
  assert.equal(core.resolveWeekSpec('last', '2026-10-28'), '2026-W43')
  assert.equal(core.resolveWeekSpec('-1', '2026-10-28'), '2026-W43')
  assert.equal(core.resolveWeekSpec('current', '2026-10-28'), '2026-W44')
})

test('frontmatter 解析（短列表 + 引号）', () => {
  const md = readFileSync(join(VAULT, 'life/dreams/2026-10-27.md'), 'utf8')
  const { data } = core.parseFrontmatter(md)
  assert.equal(data.type, 'dream')
  assert.equal(data.domain, 'life')
  assert.ok(Array.isArray(data.tags))
  assert.ok(data.tags.includes('dream-report'))
  assert.ok(data.related.includes('[[2026-10-27]]'))
})

test('Dream 抽取：事项 / T 计划 / G 计划 / 今日重点', () => {
  const md = readFileSync(join(VAULT, 'life/dreams/2026-10-26.md'), 'utf8')
  const dream = core.parseDream(md)
  assert.ok(dream.summary.length > 20)
  assert.equal(dream.items.length, 6)
  assert.ok(dream.items.every((i) => i.title && i.result))
  // T 计划不重复（曾经每项出现两次）
  const ids = dream.taskPlans.map((p) => p.id)
  assert.deepEqual([...new Set(ids)].length, ids.length)
  assert.ok(dream.taskPlans.some((p) => p.kind === 'new-task'))
  assert.ok(dream.taskPlans.every((p) => p.approval))
  assert.deepEqual(dream.gitPlans.map((g) => g.id), ['G1', 'G2', 'G3', 'G4'])
  assert.deepEqual(dream.focus.map((f) => f.n), [1, 2, 3])
})

test('journal 抽取：Progress/Blockers/Threads + 审批块', () => {
  const md = readFileSync(join(VAULT, 'life/journal/2026-10-27.md'), 'utf8')
  const journal = core.parseJournal(md)
  assert.ok(journal.progress.length >= 3)
  assert.ok(journal.blockers.length >= 3)
  assert.ok(journal.threads.length >= 3)
  assert.ok(journal.review.entries.length > 5)
  assert.ok(journal.review.done.length > 0)
  assert.ok(journal.review.entries.some((e) => e.sha))
})

test('facts pack：W44 缺 Dream 时回退 journal，并标出 gap', () => {
  const facts = buildFacts('2026-W44')
  assert.equal(facts.start, '2026-10-26')
  assert.equal(facts.end, '2026-11-01')
  assert.equal(facts.days.length, 7)
  assert.equal(facts.complete, false)
  const d26 = facts.days.find((d) => d.date === '2026-10-26')
  assert.ok(d26.dream)
  assert.ok(d26.items.length > 0)
  // fixture 在 10-28 当天没有 journal/dream → gap
  assert.ok(facts.gaps.includes('2026-10-28'))
  const gap = facts.gapDetail.find((g) => g.date === '2026-10-28')
  assert.equal(gap.today, true)
  // 缺失日不编造：该天所有事实为空
  const d28 = facts.days.find((d) => d.date === '2026-10-28')
  assert.equal(d28.items.length, 0)
  assert.equal(d28.blockers.length, 0)
})

test('数据口径：覆盖天数与缺失日都写出来', () => {
  const facts = buildFacts('2026-W43')
  const coverage = core.renderCoverage(facts)
  assert.match(coverage, /## 数据口径/)
  assert.match(coverage, /覆盖：7 天/)
  assert.match(coverage, /Dream 2 \/ journal 7/)
  const trend = core.renderTrend(facts)
  assert.match(trend, /## 趋势/)
  assert.match(trend, /commits：/)
  assert.match(trend, /touched tasks：/)
})

test('趋势：git 可用时输出 commits 数字与按天计数', () => {
  const facts = buildFacts('2026-W43')
  const withGit = {
    ...facts,
    git: {
      available: true,
      by_day: { '2026-10-19': 2, '2026-10-20': 1 },
      commits: [
        { sha: 'aaa1111', date: '2026-10-19', msg: 'a' },
        { sha: 'bbb2222', date: '2026-10-19', msg: 'b' },
        { sha: 'ccc3333', date: '2026-10-20', msg: 'c' },
      ],
    },
  }
  const trend = core.renderTrend(withGit)
  assert.match(trend, /commits：3/)
  assert.match(trend, /10-19: 2/)
  assert.match(trend, /10-20: 1/)
})

test('touched tasks：frontmatter.updated 落在本周的任务被选中', () => {
  const touched = core.collectTasks(VAULT, '2026-10-19', '2026-10-25', [])
  assert.deepEqual(touched.map((t) => t.task).sort(), ['修复周报幂等', '整理插件发布清单'])
  assert.ok(touched.every((t) => t.source === 'frontmatter-updated'))
  assert.ok(touched.every((t) => t.updated >= '2026-10-19' && t.updated <= '2026-10-25'))
})

test('结构校验：缺章节/多章节/代码围栏都要报错', () => {
  const good = [
    '## 本周一句话',
    '10-27 把 X 落地。',
    '## 进展（按项目 / 任务）',
    '### X',
    '- 起因：10-26 起',
    '## 反复出现的 blocker',
    '- 本周无跨天重复的 blocker。',
    '## 未闭环',
    '- 10-27 Y 未提交',
  ].join('\n')
  assert.equal(core.validateBody(good).ok, true)
  assert.equal(core.validateBody(good.replace('## 未闭环', '## 其它')).ok, false)
  assert.equal(core.validateBody('```\n' + good + '\n```').ok, false)
  assert.equal(core.validateBody('').ok, false)
})

test('词汇校验：输入外的新术语要被抓出来', () => {
  const facts = buildFacts('2026-W43')
  const allowed = buildVocabulary(facts)
  assert.ok(allowed.size > 100)
  const ok = checkVocabulary('10-20 修了 `check_release_notes.py`，见 [[2026-10-20]]。', allowed)
  // 输入外的新词应报未知
  const bad = checkVocabulary('本周新增 ZZZUnseenAbc 指标。', allowed)
  assert.equal(bad.ok, false)
  assert.ok(bad.unknown.some((u) => u.token === 'ZZZUnseenAbc'))
  assert.equal(ok.unknown.filter((u) => u.token === 'ZZZUnseenAbc').length, 0)
})

test('prompt：包含规则、术语表与 facts；不含趋势/数据口径要求', () => {
  const facts = buildFacts('2026-W44')
  const prompt = buildPrompt(facts)
  assert.match(prompt, /2026-W44/)
  // 只依赖稳定结构：标题文案可能调整，但合成器名称与规则小节不变
  assert.match(prompt, /Routine 周报合成器/)
  assert.match(prompt, /词汇复用/)
  assert.match(prompt, /术语表/)
  assert.match(prompt, /## 反复出现的 blocker/)
  assert.ok(prompt.length > 5000)
  assert.equal(PROMPT_VERSION.startsWith('routine-'), true)
})

test('幂等写：只替换 generated 块，手写区保留', () => {
  const facts = buildFacts('2026-W43')
  const hash = core.computeFactsHash(facts, 'test')
  const body = core.renderDeterministicBody(facts)
  const file1 = core.renderRoutineFile(facts, body, hash)
  const withNote = file1 + '\n## 手写补充\n\n- 不要丢。\n'
  const block2 = core.renderGeneratedBlock(facts, body + '\n\n<!-- x -->', hash)
  const file2 = core.replaceGeneratedBlock(withNote, block2)
  assert.equal(file2.includes('## 手写补充'), true)
  assert.equal(file2.includes('不要丢。'), true)
  assert.equal(file2.split('<!-- sleep-routine:generated -->').length, 2)
  // 再替换回同样内容 → 字节一致
  const file3 = core.replaceGeneratedBlock(file2, block2)
  assert.equal(file3, file2)
})

test('哈希：facts 变了哈希才变', () => {
  const a = buildFacts('2026-W43')
  const b = buildFacts('2026-W43')
  assert.equal(core.computeFactsHash(a, 'x'), core.computeFactsHash(b, 'x'))
  assert.notEqual(core.computeFactsHash(a, 'x'), core.computeFactsHash(a, 'y'))
  const c = buildFacts('2026-W44')
  assert.notEqual(core.computeFactsHash(a, 'x'), core.computeFactsHash(c, 'x'))
})

test('writer 端到端：两次 --no-llm 结果一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'routine-'))
  mkdirSync(dir, { recursive: true })
  const facts = buildFacts('2026-W43')
  const hash = core.computeFactsHash(facts, 'no-llm|auto')
  const body = core.renderDeterministicBody(facts)
  const one = core.renderRoutineFile(facts, body, hash)
  writeFileSync(join(dir, 'a.md'), one)
  const two = core.replaceGeneratedBlock(readFileSync(join(dir, 'a.md'), 'utf8'), core.renderGeneratedBlock(facts, body, hash))
  writeFileSync(join(dir, 'b.md'), two)
  assert.equal(readFileSync(join(dir, 'a.md'), 'utf8'), readFileSync(join(dir, 'b.md'), 'utf8'))
  assert.match(one, /type: routine/)
  assert.match(one, /status: final/)
})

// ---------------------------------------------------------------------------
// 清单/契约自检（插件包本身要能装进 profile）
// ---------------------------------------------------------------------------

test('清单：package.json 的 dsh 声明与导出目标都存在', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  // 发布包名（与 lib/client.js 的 ModuleLoader id 同步）
  assert.equal(pkg.name, '@dsh-external/dsh-work-review')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.dsh.client.immediately, true)
  assert.ok(Array.isArray(pkg.dsh.client.inject) && pkg.dsh.client.inject.length > 0)
  for (const target of [pkg.main, pkg.dsh.bundle.patch, pkg.exports['./client'].default, pkg.exports['./icon']]) {
    assert.ok(existsSync(new URL(`../${target.replace('./', '')}`, import.meta.url)), `${target} 不存在`)
  }
})

test('清单：client 的 PANEL_VERSION 跟随 package.json 版本', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const version = /const PANEL_VERSION = '([^']+)'/.exec(code)?.[1]
  assert.equal(version, pkg.version)
})

test('清单：locale 元数据齐全（Plugin Manager 读 meta.title/description）', () => {
  for (const lang of ['en', 'zh']) {
    const file = new URL(`../locale/${lang}.json`, import.meta.url)
    const data = JSON.parse(readFileSync(file, 'utf8'))
    assert.ok(data.meta && data.meta.title && data.meta.description, `${lang}.json 缺 meta`)
  }
})

test('清单：icon 是 <256KiB 的 SVG', () => {
  const file = new URL('../icon.svg', import.meta.url)
  const buf = readFileSync(file)
  assert.ok(buf.byteLength < 256 * 1024)
  assert.match(buf.toString('utf8', 0, 200), /^<svg/)
})

test('client 契约：ModuleLoader id = 包名；注册左栏 sidebar.panellist + main 面板；不 import Harness Client 包', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(code, new RegExp(`id:\\s*'${pkg.name.replace(/[/@]/g, '\\$&')}'`))
  // 2026-10-30：从 session 头部 conversation.view 移到主界面左栏（自动化任务下面）
  assert.doesNotMatch(code, /conversation\.view/)
  assert.match(code, /const PANEL_ID = 'routine'/)
  assert.match(code, /name:\s*'sidebar\.panellist'/)
  assert.match(code, /name:\s*'main'/)
  assert.match(code, /key:\s*PANEL_ID/)
  assert.match(code, /order:\s*20/)
  assert.match(code, /inject:\s*\['slots',\s*'layout'\]/)
  assert.match(code, /inputActions/)
  assert.match(code, /captureInsertion/)
  assert.match(code, /insertText/)
  // 只用主题 token 上色，不硬编码颜色
  assert.doesNotMatch(code, /require\('@deepseek-ai\//)
  assert.doesNotMatch(code, /#(?:[0-9a-fA-F]{3}){1,2}\b/)
  // client 依赖：注册左栏条目要有 layout 与 sidebar 先加载
  assert.deepEqual(pkg.dsh.client.inject, [
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-client-ui-sidebar',
  ])
})

test('host 契约：只读路由 + tool 的 parameters 是合法 JSON Schema 对象', () => {
  const code = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(code, /kind: 'prefix'/)
  assert.match(code, /path: '\/work-review\/api'/)
  // 这条断言防的是 2026-10-28 那次线上事故：
  // parameters 少写 type:'object' 会让每次 LLM 请求都被 400 拒绝。
  assert.match(code, /parameters:\s*\{\s*\n\s*type: 'object'/)
  assert.doesNotMatch(code, /parameters:\s*\{\s*\n\s*(week|date):/)
})

// ---------------------------------------------------------------------------
// 链接质量回归（2026-10-28：裸日期 wikilink 在 dreams/journal/ingest 之间歧义）
// ---------------------------------------------------------------------------

test('related：路径限定，不留裸日期 wikilink', () => {
  const facts = buildFacts('2026-W43')
  const lines = core.relatedLinks(facts)
  assert.ok(lines.length >= 7)
  for (const line of lines) {
    assert.match(line, /\[\[life\/(journal|dreams|notes\/ingest)\/\d{4}-\d{2}-\d{2}\|/, line)
    assert.doesNotMatch(line, /\[\[\d{4}-\d{2}-\d{2}\]\]/, line)
  }
})

test('normalizeDateLinks：只改裸日期，不动已限定链接与日期前缀页面', () => {
  const facts = buildFacts('2026-W43')
  const body = [
    '见 [[2026-10-19]]、[[2026-10-20|那天]]。',
    '已限定：[[life/journal/2026-10-19|10-19 日记]]。',
    '页面名以日期开头但不是日期链接：[[2026-10-20-release-notes]]。',
    '不在本周：[[2026-01-01]]。',
  ].join('\n')
  const out = core.normalizeDateLinks(body, facts)
  assert.match(out, /\[\[life\/journal\/2026-10-19\|2026-10-19\]\]/)
  assert.match(out, /\[\[life\/journal\/2026-10-20\|那天\]\]/)
  assert.match(out, /\[\[life\/journal\/2026-10-19\|10-19 日记\]\]/)
  assert.match(out, /\[\[2026-10-20-release-notes\]\]/)
  assert.match(out, /\[\[2026-01-01\]\]/) // 不在 facts 的周内 → 原样保留（由引用校验负责拦）
})

test('renderWithFreshFrontmatter：重建 frontmatter 但保留手写区', () => {
  const facts = buildFacts('2026-W43')
  const hash = core.computeFactsHash(facts, 'test')
  const body = core.renderDeterministicBody(facts)
  const old = core.renderRoutineFile(facts, body, hash) + '\n## 手写补充\n\n- 不能丢。\n'
  const fresh = core.renderWithFreshFrontmatter(facts, body, hash, old)
  assert.match(fresh, /\[\[life\/journal\/2026-10-19\|/)
  assert.equal(fresh.includes('不能丢。'), true)
  assert.equal(fresh.split('<!-- sleep-routine:generated -->').length, 2)
  // 再走一次幂等替换，结果不变
  const again = core.replaceGeneratedBlock(fresh, core.renderGeneratedBlock(facts, body, hash))
  assert.equal(again.includes('不能丢。'), true)
  assert.equal(again.split('<!-- sleep-routine:generated:end -->').length, 2)
})
