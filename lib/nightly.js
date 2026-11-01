#!/usr/bin/env node
/**
 * nightly.js — 每日早报（Dream）生成入口；automation/run-nightly.sh 与 launchd 走这里。
 *
 *   daily facts(daily.js) → prompt(dream.js) → `dsh --profile headless`
 *     → 结构校验 → 幂等写 life/dreams/<date>.md →（可选）链式 review.js
 *
 * 与 cli.js 的分工：cli.js 生成 ISO 周周报（周末跑一次），nightly.js 生成「昨天」
 * 的早报（每天 05:00 跑）。两者共用 core.js 的数据层和同一个 provider 表。
 *
 * 退出码：0 成功/未变化；2 参数或环境错误；3 输出校验失败；4 provider 全部失败。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as core from './core.js'
import * as config from './config.js'
import { buildDailyFacts, resolveDateSpec } from './daily.js'
import {
  DREAM_MARKER,
  buildDreamCorrectivePrompt,
  buildDreamPrompt,
  computeDreamHash,
  existingDreamHash,
  normalizeDreamOutput,
  renderDreamFile,
  renderDreamSkeleton,
  validateDreamBody,
} from './dream.js'
import { readCredential, runProvider } from './cli.js'

function usage() {
  return `用法: node lib/nightly.js [选项]

生成某一天的早报（Dream）：${'`'}life/dreams/<date>.md${'`'}。

选项:
  --date <spec>          today | yesterday | YYYY-MM-DD | -1（默认 yesterday）
  --vault <dir>          vault 根目录（默认 $DSH_WORK_REVIEW_VAULT 或 ~/.dsh/work-review.json 的 vaultRoot）
  --out-dir <dir>        早报输出目录（默认 <vault>/life/dreams）
  --day-start-hour <n>   一天的起点小时，0-23（默认 5；凌晨的活算前一天）
  --dry-run              只打印 facts 摘要与 prompt 统计，不调模型、不写文件
  --facts-out <path>     把 facts pack 写到指定 JSON 文件
  --prompt-out <path>    把完整 prompt 写到指定文件（调试用）
  --body-file <path>     用现成的 markdown 正文代替模型（跳过 provider）
  --no-llm               用确定性骨架正文（未经合成，只列事实）
  --force                忽略 facts 哈希，强制重新合成
  --timeout <sec>        单次 provider 超时（默认 600）
  --provider <id>        auto | dsh-default | 配置文件 providers 里定义的 id（默认 auto）
  --no-retry             校验失败不重试（只跑一次合成）
  --review               写完后链式执行 review.js（默认 dry-run）
  --review-live          链式执行且允许写入/本地 commit（只影响 --review）
  --quiet                不往 stderr 打日志
  -h, --help             显示帮助

配置文件：~/.dsh/work-review.json（可与面板共用）。最少写 {"vaultRoot": "<dir>"}。
`
}

export function parseArgs(argv) {
  const args = {
    date: 'yesterday',
    vault: '',
    outDir: '',
    dayStartHour: 5,
    dryRun: false,
    factsOut: '',
    promptOut: '',
    bodyFile: '',
    noLlm: false,
    force: false,
    timeout: 600,
    provider: 'auto',
    noRetry: false,
    review: false,
    reviewLive: false,
    quiet: false,
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
      case '--out-dir': args.outDir = next(); break
      case '--day-start-hour': args.dayStartHour = Number(next()); break
      case '--dry-run': args.dryRun = true; break
      case '--facts-out': args.factsOut = next(); break
      case '--prompt-out': args.promptOut = next(); break
      case '--body-file': args.bodyFile = next(); break
      case '--no-llm': args.noLlm = true; break
      case '--force': args.force = true; break
      case '--timeout': args.timeout = Number(next()); break
      case '--provider': args.provider = next(); break
      case '--no-retry': args.noRetry = true; break
      case '--review': args.review = true; break
      case '--review-live': args.review = true; args.reviewLive = true; break
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

/** 缓存目录：不可写时退到系统临时目录；再不行就返回空串（调用方跳过写缓存）。 */
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

/** 写缓存是诊断增强，失败不能影响主流程。返回实际路径或空串。 */
function writeCache(file, text) {
  const dir = cacheDir()
  if (!dir) return ''
  try {
    const abs = join(dir, file)
    writeFileSync(abs, text)
    return abs
  } catch {
    return ''
  }
}

function makeLogger(date, quiet) {
  const lines = []
  const log = (msg) => {
    const line = `[${stamp()}] ${msg}`
    lines.push(line)
    if (!quiet) console.error(line)
  }
  log.flush = () => {
    const dir = cacheDir()
    if (!dir) return
    try {
      writeFileSync(join(dir, `nightly-${date}.log`), lines.join('\n') + '\n')
    } catch {
      /* 日志失败不影响主流程 */
    }
  }
  return log
}

/** 链式跑 review.js；返回子进程退出码。 */
export function chainReview({ vaultRoot, date, live, timeout, provider, quiet }) {
  return new Promise((resolvePromise) => {
    const script = resolve(dirname(fileURLToPath(import.meta.url)), 'review.js')
    const argv = [script, '--date', date, '--vault', vaultRoot, '--run']
    if (live) argv.push('--live')
    if (timeout) argv.push('--timeout', String(timeout))
    if (provider && provider !== 'auto') argv.push('--provider', provider)
    if (quiet) argv.push('--quiet')
    const child = spawn(process.execPath, argv, { cwd: vaultRoot, stdio: 'inherit' })
    child.on('error', () => resolvePromise(1))
    child.on('close', (code) => resolvePromise(code ?? 1))
  })
}

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
  if (!existsSync(vaultRoot)) {
    console.error(`vault 不存在: ${vaultRoot}`)
    return 2
  }

  let date
  try {
    date = resolveDateSpec(args.date)
  } catch (err) {
    console.error(err.message)
    return 2
  }

  let facts
  try {
    facts = buildDailyFacts({
      vaultRoot,
      date,
      dayStartHour: args.dayStartHour,
    })
  } catch (err) {
    console.error(`facts 构建失败: ${err.message}`)
    return 2
  }

  const outDir = args.outDir ? resolve(args.outDir) : join(vaultRoot, core.REL.dreams)
  const target = join(outDir, `${facts.date}.md`)
  const log = makeLogger(facts.date, args.quiet)
  log(`date=${facts.date} window ${facts.window.start} → ${facts.window.end} vault=${vaultRoot}`)

  const modeTag = args.noLlm ? 'no-llm' : 'synthesized'
  const hash = computeDreamHash(facts, modeTag)
  const existingText = existsSync(target) ? readFileSync(target, 'utf8') : null
  const existingHash = existingText ? existingDreamHash(existingText) : null
  const unchanged = Boolean(!args.force && existingText && existingHash === hash)


  if (args.factsOut) {
    writeFileSync(resolve(args.factsOut), JSON.stringify(facts, null, 2) + '\n')
    log(`facts 已写入 ${resolve(args.factsOut)}`)
  }

  if (args.dryRun) {
    const promptText = buildDreamPrompt(facts)
    if (args.promptOut) writeFileSync(resolve(args.promptOut), promptText)
    const summary = {
      date: facts.date,
      window: [facts.window.start, facts.window.end],
      dayStartHour: facts.window.dayStartHour,
      target,
      existingHash,
      newHash: hash,
      unchanged,
      journal: facts.sources.journal,
      ingest: facts.sources.ingest,
      commits: facts.git.available ? facts.git.commits.length : null,
      dirty: facts.git.available ? facts.git.dirty.length : null,
      openTasks: facts.tasks.length,
      missing: facts.missing,
      promptChars: promptText.length,
      providers: config.resolveProviders({ vaultRoot }).map((p) => ({
        id: p.id,
        patchExists: p.patch ? existsSync(p.patch) : true,
        keyPresent: p.keyEnv ? Boolean(readCredential(p.keyEnv)) : true,
      })),
    }
    console.log(JSON.stringify(summary, null, 2))
    if (!args.quiet) console.error(promptText.slice(0, 1200))
    log.flush()
    return 0
  }


  // 已有早报但不是本工具生成的（例如手写的，或另一个工具的格式）：不覆盖，
  // 除非显式 --force。宁可让用户看见一条错误，也不静默吞掉已有内容。
  if (existingText && !existingText.includes(DREAM_MARKER) && !args.force) {
    console.error(
      `已存在不是本工具生成的早报: ${target}\n` +
        '  加 --force 会用本次生成的内容替换它（手写内容会丢）。',
    )
    log('目标文件已有内容且没有 work-review 生成块，拒绝覆盖（需要 --force）')
    log.flush()
    return 2
  }

  if (unchanged) {
    console.log(`未变化：${target}（facts 哈希 ${hash}，跳过模型；要强制重跑加 --force）`)
    log('facts 哈希一致，跳过合成')
    log.flush()
    return finishWithReview(args, { vaultRoot, date: facts.date, log })
  }

  let body = ''
  let provider = 'none'
  let validation = { ok: true, errors: [], warnings: [], counts: {} }
  const basePrompt = buildDreamPrompt(facts)
  if (args.promptOut) {
    writeFileSync(resolve(args.promptOut), basePrompt)
    log(`prompt 已写入 ${resolve(args.promptOut)}`)
  }

  if (args.noLlm) {
    body = renderDreamSkeleton(facts)
    provider = 'no-llm'
    log('--no-llm：使用确定性骨架正文')
  } else if (args.bodyFile) {
    body = normalizeDreamOutput(readFileSync(resolve(args.bodyFile), 'utf8'))
    provider = 'body-file'
    validation = validateDreamBody(body, facts)
    for (const w of validation.warnings) log(`告警：${w}`)
    log(`用现成正文 ${resolve(args.bodyFile)}（${body.length} bytes，校验${validation.ok ? '通过' : '失败'}）`)
  } else {
    const maxAttempts = args.noRetry ? 1 : 2
    let promptText = basePrompt
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      log(`合成第 ${attempt}/${maxAttempts} 次（prompt ${promptText.length} chars）`)
      const result = await synthesizeDream({ args, vaultRoot, promptText, log })
      if (!result.ok) {
        if (attempt >= maxAttempts) {
          console.error(`所有 provider 都失败；未写入任何文件。详见 ${join(cacheDir(), `nightly-${facts.date}.log`)}`)
          log('所有 provider 失败')
          log.flush()
          return 4
        }
        continue
      }
      provider = result.provider
      body = normalizeDreamOutput(result.text)
      writeCache(`dream-${facts.date}.md`, body)
      validation = validateDreamBody(body, facts)
      for (const w of validation.warnings) log(`告警：${w}`)
      if (validation.ok) break
      log(`第 ${attempt} 次校验失败：${validation.errors.join('；')}`)
      if (attempt < maxAttempts) promptText = buildDreamCorrectivePrompt(basePrompt, validation)
    }
    if (!validation.ok) {
      const rejected = writeCache(`rejected-dream-${facts.date}.md`, body)
      console.error(`输出校验失败（provider=${provider}），未写入 ${target}`)
      for (const e of validation.errors) console.error(`  ${e}`)
      if (rejected) console.error(`  原始输出已存 ${rejected}`)
      log('校验失败')
      log.flush()
      return 3
    }
  }

  // body-file / no-llm 路径也要过同一套校验；LLM 路径已在上面返回 3。
  if (!validation.ok) {
    const rejected = writeCache(`rejected-dream-${facts.date}.md`, body)
    console.error(`输出校验失败（provider=${provider}），未写入 ${target}`)
    for (const e of validation.errors) console.error(`  ${e}`)
    if (rejected) console.error(`  原始输出已存 ${rejected}`)
    log('校验失败')
    log.flush()
    return 3
  }

  mkdirSync(dirname(target), { recursive: true })
  const text = renderDreamFile(facts, body, hash, existingText)
  writeFileSync(target, text)
  const bytes = Buffer.byteLength(text)
  console.log(
    [
      `已写入 ${target}`,
      `- date: ${facts.date}（${facts.weekdayLabel}；窗口 ${facts.window.start} → ${facts.window.end}）`,
      `- 正文来源: ${provider}${args.noLlm ? '（确定性骨架，未合成）' : ''}`,
      `- commits: ${facts.git.available ? facts.git.commits.length : 'n/a'}；未关闭任务: ${facts.tasks.length}`,
      validation.counts && validation.counts.taskPlans != null
        ? `- 计划: T×${validation.counts.taskPlans}、G×${validation.counts.gitPlans}、重点任务×${validation.counts.focus}、成果×${validation.counts.items}`
        : null,
      `- facts 哈希: ${hash}；${existingText ? '已保留手写区' : '新文件'}`,
      `- bytes: ${bytes}`,
    ]
      .filter(Boolean)
      .join('\n'),
  )
  log(`写入 ${target}（${bytes} bytes, provider=${provider}, hash=${hash}）`)
  log.flush()
  return finishWithReview(args, { vaultRoot, date: facts.date, log })
}

/** --review：链式执行审批；失败不覆盖早报本身的成功。 */
async function finishWithReview(args, { vaultRoot, date, log }) {
  if (!args.review) return 0
  log(`链式 review（${args.reviewLive ? 'live' : 'dry-run'}）`)
  const code = await chainReview({
    vaultRoot,
    date,
    live: args.reviewLive,
    timeout: args.timeout,
    provider: args.provider,
    quiet: args.quiet,
  })
  if (code !== 0) log(`review 退出码 ${code}（早报已写入）`)
  log.flush()
  return 0
}

/** 早报合成的 provider 调用：只读模式（生成阶段不许写 vault）。 */
export async function synthesizeDream({ args, vaultRoot, promptText, log }) {
  const providers = config.resolveProviders({ vaultRoot })
  const wanted = args.provider === 'auto' ? providers : providers.filter((p) => p.id === args.provider)
  if (!wanted.length) throw new Error(`未知 provider: ${args.provider}`)
  for (const provider of wanted) {
    const result = await runProvider({
      provider,
      promptText,
      vaultRoot,
      timeoutSec: args.timeout,
      log,
      permissionMode: 'read-only',
    })
    if (result.ok) return { ok: true, text: result.stdout, provider: provider.id }
  }
  return { ok: false, provider: null }
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]).endsWith(join('lib', 'nightly.js'))
if (isDirectRun) {
  main().then((code) => {
    process.exitCode = code
  })
}
