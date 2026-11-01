#!/usr/bin/env node
/**
 * cli.js — 工作回顾（Work Review）的生成入口（launchd / 手动补跑都走这里）。
 *
 *   facts(core) → prompt(prompt.js) → `dsh --profile headless` → 校验 → 幂等写 life/routines/<week>.md
 *
 * 设计要点：
 *   - provider 只是可选增强：默认直接跑 headless profile 的默认模型；自定义 patch 写在
 *     ~/.dsh/work-review.json 的 providers 里。
 *   - 事实哈希没变就跳过 LLM：重跑同一周不会重写文件，天然幂等。
 *   - 趋势/数据口径两节由脚本渲染，不交给模型（避免编数字）。
 *   - 结构或词汇校验不过 → 默认不写文件（exit 3），原始输出留在 ~/.cache/work-review/。
 *
 * 退出码：0 成功/未变化；2 参数或环境错误；3 输出校验失败；4 provider 全部失败。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import * as core from './core.js'
import * as config from './config.js'
import {
  PROMPT_VERSION,
  buildCorrectivePrompt,
  buildPrompt,
  buildVocabulary,
  checkCitations,
  checkThreadShape,
  checkVocabulary,
  factsForPrompt,
  quotedTerms,
} from './prompt.js'

// ---------------------------------------------------------------------------
// 环境
// ---------------------------------------------------------------------------

const DEFAULT_DSH = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
const CREDENTIALS = join(homedir(), '.dsh', '.credentials.yaml')

/** provider 表：内建 headless 默认模型 + ~/.dsh/work-review.json 里配置的高级 provider。 */
function providersOf(vaultRoot) {
  return config.resolveProviders({ vaultRoot })
}

function cacheDir() {
  const dir = config.resolveCacheDir()
  mkdirSync(dir, { recursive: true })
  return dir
}

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

function makeLogger(week, quiet) {
  const lines = []
  const log = (msg) => {
    const line = `[${stamp()}] ${msg}`
    lines.push(line)
    if (!quiet) console.error(line)
  }
  log.flush = () => {
    try {
      writeFileSync(join(cacheDir(), `run-${week}.log`), lines.join('\n') + '\n')
    } catch {
      /* 日志失败不影响主流程 */
    }
  }
  return log
}

/** 读 DSH 凭据（env 优先；只读文件，不打印） */
export function readCredential(name) {
  if (process.env[name]) return process.env[name]
  try {
    const text = readFileSync(CREDENTIALS, 'utf8')
    const m = new RegExp(`^\\s+${name}:\\s*"?([^"\\n]+)"?\\s*$`, 'm').exec(text)
    return m ? m[1].trim() : ''
  } catch {
    return ''
  }
}

function dshBinary() {
  const candidate = config.resolveDshCli() || DEFAULT_DSH
  if (existsSync(candidate)) return candidate
  return 'dsh'
}

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

function usage() {
  return `用法: node lib/cli.js [选项]

选项:
  --week <spec>          week spec: last | current | YYYY-Www | -1（默认 last）
  --vault <dir>          vault 根目录（默认 $DSH_WORK_REVIEW_VAULT 或 ~/.dsh/work-review.json 的 vaultRoot）
  --out-dir <dir>        输出目录（默认 <vault>/life/routines）
  --dry-run              只打印 facts 摘要与 prompt 统计，不调 LLM、不写文件
  --facts-out <path>     把 facts pack 写到指定 JSON 文件
  --prompt-out <path>    把完整 prompt 写到指定文件（调试用）
  --body-file <path>     用现成的 markdown 正文代替 LLM（跳过 provider）
  --no-llm               用确定性骨架正文（未经合成，status 仍按周标记）
  --force                忽略 facts 哈希，强制重新合成
  --timeout <sec>        单次 provider 超时（默认 600）
  --provider <id>        auto | dsh-default | 配置文件 providers 里定义的 id（默认 auto）
  --allow-vocab-warnings 词汇校验只告警，不阻断写入
  --no-retry             校验失败不重试（只跑一次合成）
  --rewrite-frontmatter  重写 frontmatter（刷新 related 等派生字段），保留 generated:end 之后的手写区
  --quiet                不往 stderr 打日志
  -h, --help             显示帮助

配置文件：~/.dsh/work-review.json（可用 $DSH_WORK_REVIEW_CONFIG 覆盖路径）。
最少写 {"vaultRoot": "<dir>"}；高级用法再写 providers 数组接自己的 headless patch。
`
}

export function parseArgs(argv) {
  const args = {
    week: 'last',
    vault: '',
    outDir: '',
    dryRun: false,
    factsOut: '',
    promptOut: '',
    bodyFile: '',
    noLlm: false,
    force: false,
    timeout: 600,
    provider: 'auto',
    allowVocabWarnings: false,
    noRetry: false,
    rewriteFrontmatter: false,
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
      case '--week': args.week = next(); break
      case '--vault': args.vault = next(); break
      case '--out-dir': args.outDir = next(); break
      case '--dry-run': args.dryRun = true; break
      case '--facts-out': args.factsOut = next(); break
      case '--prompt-out': args.promptOut = next(); break
      case '--body-file': args.bodyFile = next(); break
      case '--no-llm': args.noLlm = true; break
      case '--force': args.force = true; break
      case '--timeout': args.timeout = Number(next()); break
      case '--provider': args.provider = next(); break
      case '--allow-vocab-warnings': args.allowVocabWarnings = true; break
      case '--no-retry': args.noRetry = true; break
      case '--rewrite-frontmatter': args.rewriteFrontmatter = true; break
      case '--quiet': args.quiet = true; break
      case '-h':
      case '--help': args.help = true; break
      default:
        throw new Error(`未知参数: ${arg}`)
    }
  }
  return args
}

// ---------------------------------------------------------------------------
// headless 调用
// ---------------------------------------------------------------------------

/** 跑一个 provider；返回 {ok, stdout, stderr, code, ms}。 */
export function runProvider({ provider, promptText, vaultRoot, timeoutSec, log, permissionMode = 'read-only' }) {
  return new Promise((resolvePromise) => {
    if (provider.patch && !existsSync(provider.patch)) {
      log(`skip ${provider.id}: patch 不存在 ${provider.patch}`)
      resolvePromise({ ok: false, reason: 'patch-missing' })
      return
    }
    const key = provider.keyEnv ? readCredential(provider.keyEnv) : ''
    if (provider.keyEnv && !key) {
      log(`skip ${provider.id}: ${provider.keyEnv} 为空`)
      resolvePromise({ ok: false, reason: 'key-missing' })
      return
    }
    const bin = dshBinary()
    const env = {
      ...process.env,
      // 生成默认只读：让它能读 vault，但不能写（不依赖模型自觉）。
      // 审批执行（lib/review.js --live）会显式传入 workspace-write。
      DSH_PERMISSION_MODE: permissionMode,
    }
    if (provider.keyEnv) env[provider.keyEnv] = key
    const started = Date.now()
    log(`--- ${provider.label} 开始（timeout=${timeoutSec}s）---`)
    // 没有 patch 的 provider 直接用 headless profile 的默认模型（官方 DeepSeek 默认走这条）。
    const argv = ['--profile', 'headless', ...(provider.patch ? ['--patch', provider.patch] : []), '-']
    const child = spawn(bin, argv, {
      cwd: vaultRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      log(`${provider.id} 超时 ${timeoutSec}s，终止`)
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5000).unref?.()
    }, timeoutSec * 1000)
    timer.unref?.()

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      log(`${provider.id} 启动失败: ${err.message}`)
      resolvePromise({ ok: false, reason: 'spawn-failed', stdout, stderr })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const ms = Date.now() - started
      const tail = stderr.trim().split('\n').slice(-6).join(' | ')
      if (tail) log(`${provider.id} stderr: ${tail}`)
      if (code !== 0) {
        log(`${provider.id} 失败（exit=${code}, ${ms}ms）`)
        resolvePromise({ ok: false, reason: 'exit', code, stdout, stderr, ms })
        return
      }
      if (!stdout.trim()) {
        log(`${provider.id} 退出 0 但没有最终消息`)
        resolvePromise({ ok: false, reason: 'empty', stdout, stderr, ms })
        return
      }
      log(`${provider.id} 成功（${ms}ms, ${stdout.length} bytes）`)
      resolvePromise({ ok: true, stdout, stderr, code, ms })
    })
    child.stdin.write(promptText)
    child.stdin.end()
  })
}

/** 按顺序试 provider，第一个成功的胜出。 */
export async function synthesize({ args, facts, vaultRoot, log, promptText }) {
  const all = providersOf(vaultRoot)
  const wanted =
    args.provider === 'auto' ? all : all.filter((p) => p.id === args.provider)
  if (!wanted.length) throw new Error(`未知 provider: ${args.provider}`)
  for (const provider of wanted) {
    const result = await runProvider({
      provider,
      promptText,
      vaultRoot,
      timeoutSec: args.timeout,
      log,
    })
    if (result.ok) return { ok: true, text: result.stdout, provider: provider.id }
  }
  return { ok: false, provider: null }
}

// ---------------------------------------------------------------------------
// LLM 输出清洗
// ---------------------------------------------------------------------------

/** 去掉代码围栏、开头的一级标题、前后寒暄。 */
export function normalizeOutput(raw) {
  let text = String(raw ?? '').trim()
  const fence = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/.exec(text)
  if (fence) text = fence[1].trim()
  text = text.replace(/^\s*```(?:markdown|md)?\s*\n/, '').replace(/\n```\s*$/, '')
  text = core.stripLeadingH1(text)
  // 只保留从第一个 "## " 开始的部分（模型偶尔会加开场白）
  const firstH2 = text.search(/^##\s+/m)
  if (firstH2 > 0) text = text.slice(firstH2)
  const lastH2 = [...text.matchAll(/^##\s+/gm)].pop()
  if (lastH2) {
    const nextH1 = text.indexOf('\n# ', lastH2.index)
    if (nextH1 > 0) text = text.slice(0, nextH1)
  }
  return text.trim()
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

/** LLM 正文 + 确定性章节。 */
export function assembleBody(llmBody, facts) {
  return [llmBody.trim(), '', core.renderTrend(facts), '', core.renderCoverage(facts)]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
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
  if (!existsSync(vaultRoot)) {
    console.error(`vault 不存在: ${vaultRoot}`)
    return 2
  }

  let facts
  try {
    facts = core.buildFactsPack({ vaultRoot, week: args.week })
  } catch (err) {
    console.error(`facts 构建失败: ${err.message}`)
    return 2
  }
  const outDir = config.resolveOutDir(args.outDir, vaultRoot)
  const target = join(outDir, `${facts.week}.md`)
  const log = makeLogger(facts.week, args.quiet)
  log(`week=${facts.week} ${facts.start}→${facts.end} vault=${vaultRoot}`)

  // no-llm 的骨架正文要能和真正的合成区分开；body-file 回放的既然也是 LLM 正文，
  // 就和正常合成共用同一个哈希，保证「同一份输入 + 同一份正文 = 幂等」。
  const modeTag = args.noLlm ? 'no-llm' : 'synthesized'
  const hashExtra = `${PROMPT_VERSION}|${modeTag}`
  const hash = core.computeFactsHash(facts, hashExtra)

  if (args.factsOut) {
    writeFileSync(resolve(args.factsOut), JSON.stringify(facts, null, 2) + '\n')
    log(`facts 已写入 ${resolve(args.factsOut)}`)
  }

  const existing = existsSync(target) ? readFileSync(target, 'utf8') : null
  const existingHash = existing ? core.existingFactsHash(existing) : null
  const unchanged = Boolean(!args.force && existing && existingHash === hash)

  if (args.dryRun) {
    const promptText = buildPrompt(facts)
    if (args.promptOut) writeFileSync(resolve(args.promptOut), promptText)
    const summary = {
      week: facts.week,
      range: [facts.start, facts.end],
      complete: facts.complete,
      target,
      existingHash,
      newHash: hash,
      unchanged,
      coverage: facts.coverage,
      gaps: facts.gapDetail,
      commits: facts.git.commits.length,
      tasksTouched: facts.tasks.touched.length,
      blockerRecurrence: facts.blockers.filter((b) => b.count >= 2),
      promptChars: promptText.length,
      vocabularySize: buildVocabulary(facts).size,
      providers: providersOf(vaultRoot).map((p) => ({
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

  if (unchanged) {
    console.log(`未变化：${target}（facts 哈希 ${hash}，跳过 LLM；要强制重跑加 --force）`)
    log('facts 哈希一致，跳过合成')
    log.flush()
    return 0
  }

  // 1) 取正文（LLM 路径：结构/词汇/日期校验不过就带着失败项重试一版）
  let llmBody = ''
  let provider = 'none'
  let cleaned = ''
  let structural = { ok: true, errors: [] }
  let vocab = { ok: true, unknown: [] }
  let citations = { ok: true, unknown: [] }

  const validateBody = (text) => ({
    structural: core.validateBody(text),
    vocab: checkVocabulary(text, buildVocabulary(facts)),
    citations: checkCitations(text, facts),
  })
  const allOk = (v) => v.structural.ok && v.vocab.ok && v.citations.ok

  if (args.bodyFile) {
    llmBody = readFileSync(resolve(args.bodyFile), 'utf8')
    provider = 'body-file'
    log(`用现成正文 ${resolve(args.bodyFile)}（${llmBody.length} bytes）`)
  } else if (args.noLlm) {
    llmBody = core.renderDeterministicBody(facts)
    provider = 'no-llm'
    log('--no-llm：使用确定性骨架正文')
  } else {
    const basePrompt = buildPrompt(facts)
    if (args.promptOut) {
      writeFileSync(resolve(args.promptOut), basePrompt)
      log(`prompt 已写入 ${resolve(args.promptOut)}`)
    }
    log(`prompt ${basePrompt.length} chars, vocabulary ${buildVocabulary(facts).size}`)
    let promptText = basePrompt
    const maxAttempts = args.noRetry ? 1 : 2
    let lastProvider = null
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      log(`合成第 ${attempt}/${maxAttempts} 次`)
      const result = await synthesize({ args, facts, vaultRoot, log, promptText })
      if (!result.ok) {
        if (attempt >= maxAttempts) {
          console.error(
            `所有 provider 都失败；未写入任何文件。详见 ${join(cacheDir(), `run-${facts.week}.log`)}`,
          )
          log('所有 provider 失败')
          log.flush()
          return 4
        }
        continue
      }
      llmBody = result.text
      lastProvider = result.provider
      writeFileSync(join(cacheDir(), `llm-${facts.week}.md`), llmBody)
      cleaned = normalizeOutput(llmBody)
      ;({ structural, vocab, citations } = validateBody(cleaned))
      if (allOk({ structural, vocab, citations })) break
      log(
        `第 ${attempt} 次校验失败：结构=${structural.ok ? 'ok' : structural.errors.join('/')} 词汇=${
          vocab.ok ? 'ok' : vocab.unknown.map((u) => u.token).join(',')
        } 日期=${citations.ok ? 'ok' : citations.unknown.join(',')}`,
      )
      if (attempt < maxAttempts) promptText = buildCorrectivePrompt(basePrompt, { structural, vocab, citations })
    }
    provider = lastProvider ?? 'none'
  }

  // 2) 清洗 + 校验（body-file / no-llm 路径只做一次校验）
  if (args.bodyFile) cleaned = normalizeOutput(llmBody)
  if (args.noLlm) cleaned = llmBody
  if (args.bodyFile) ({ structural, vocab, citations } = validateBody(cleaned))
  const terms = quotedTerms(cleaned)
  // thread 链条形状只告警（不影响事实正确性，硬失败会让成功合成白跑）
  const threadShape = args.noLlm ? { ok: true, warnings: [] } : checkThreadShape(cleaned)
  if (!threadShape.ok) {
    log(`thread 形状告警 ${threadShape.warnings.length} 条：${threadShape.warnings.slice(0, 6).join('；')}`)
  }

  if (!structural.ok || (args.bodyFile && !citations.ok) || (!vocab.ok && !args.allowVocabWarnings)) {
    writeFileSync(join(cacheDir(), `rejected-${facts.week}.md`), llmBody)
    console.error(`输出校验失败（provider=${provider}），未写入 ${target}`)
    for (const e of structural.errors) console.error(`  结构: ${e}`)
    if (!vocab.ok) {
      console.error(`  词汇: ${vocab.unknown.length} 个输入外术语 → ${vocab.unknown.slice(0, 20).map((u) => u.token).join(', ')}`)
    }
    if (!citations.ok) {
      console.error(`  日期: facts 里没有 → ${citations.unknown.join(', ')}`)
    }
    console.error(`  原始输出已存 ${join(cacheDir(), `rejected-${facts.week}.md`)}`)
    log(`校验失败：${JSON.stringify({ structural, vocab: vocab.unknown.slice(0, 20) })}`)
    log.flush()
    return 3
  }
  if (!vocab.ok) {
    log(`词汇告警（${
      args.allowVocabWarnings ? '已放行' : ''
    }）：${vocab.unknown.map((u) => u.token).join(', ')}`)
  }
  if (terms.length) log(`引号术语 ${terms.length} 个（抽查用）：${terms.slice(0, 10).join(' / ')}`)

  // 3) 组装 + 幂等写（裸日期 wikilink 归一化成路径限定，避免同名文件歧义）
  const linked = args.noLlm ? cleaned : core.normalizeDateLinks(cleaned, facts)
  const body = args.noLlm ? linked : assembleBody(linked, facts)
  mkdirSync(dirname(target), { recursive: true })
  const block = core.renderGeneratedBlock(facts, body, hash)
  const text =
    existing && !args.rewriteFrontmatter
      ? core.replaceGeneratedBlock(existing, block)
      : args.rewriteFrontmatter && existing
        ? core.renderWithFreshFrontmatter(facts, body, hash, existing)
        : core.renderRoutineFile(facts, body, hash)
  writeFileSync(target, text)

  const bytes = Buffer.byteLength(text)
  console.log(
    [
      `已写入 ${target}`,
      `- week: ${facts.week}（${facts.start} → ${facts.end}）`,
      `- 覆盖: Dream ${facts.coverage.dream} / journal ${facts.coverage.journal} / ingest ${facts.coverage.ingest}；缺失 ${facts.coverage.gaps} 天`,
      `- 正文来源: ${provider}${args.noLlm ? '（确定性骨架，未合成）' : ''}`,
      `- commits: ${facts.git.commits.length}；touched tasks: ${facts.tasks.touched.length}`,
      `- thread 告警: ${threadShape.warnings.length}${threadShape.warnings.length ? `（${threadShape.warnings.slice(0, 3).join('；')}）` : ''}`,
      `- facts 哈希: ${hash}；${
        existing
          ? args.rewriteFrontmatter
            ? 'frontmatter 已重建、手写区保留'
            : '已保留 frontmatter 与手写区'
          : '新文件'
      }`,
      `- bytes: ${bytes}`,
    ].join('\n'),
  )
  log(`写入 ${target}（${bytes} bytes, provider=${provider}, hash=${hash}）`)
  log.flush()
  return 0
}

const isDirectRun =
  process.argv[1] && resolve(process.argv[1]).endsWith(join('lib', 'cli.js'))
if (isDirectRun) {
  main().then((code) => {
    process.exitCode = code
  })
}
