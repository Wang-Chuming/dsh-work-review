/**
 * config.js — 用户配置解析（vault 根目录、输出/缓存目录、DSH CLI、provider 表、审批按钮）。
 *
 * 配置来源（优先级从高到低）：
 *   1. 命令行参数（--vault 等，由各自的调用方传入）
 *   2. 环境变量：DSH_WORK_REVIEW_VAULT / DSH_WORK_REVIEW_CONFIG / DSH_CLI
 *   3. 配置文件：~/.dsh/work-review.json
 *
 * 这个模块只读、不抛错：文件不存在或 JSON 非法一律当作「没有配置」，
 * 由调用方决定降级行为（CLI 报友好错误，host 侧面板提示未配置）。
 *
 * 配置文件示例：
 *   {
 *     "vaultRoot": "/path/to/your/vault",
 *     "outDir": "life/routines",
 *     "cacheDir": "~/.cache/work-review",
 *     "dshCli": "/path/to/dsh",
 *     "providers": [
 *       { "id": "custom-headless", "label": "My headless patch",
 *         "keyEnv": "MY_HEADLESS_API_KEY", "patch": "~/patches/custom-headless.patch.yml" }
 *     ],
 *     "review": { "label": "去审批", "command": "$sleep-review {date}", "autoSend": false }
 *   }
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** 覆盖配置文件路径的环境变量。 */
export const CONFIG_ENV = 'DSH_WORK_REVIEW_CONFIG'
/** 覆盖 vault 根目录的环境变量（优先级低于 --vault）。 */
export const VAULT_ENV = 'DSH_WORK_REVIEW_VAULT'
/** 内建 provider：直接用本机 headless profile 的默认模型，不需要 patch、不需要 API key。 */
export const DEFAULT_PROVIDER_ID = 'dsh-default'

/** 展开开头的 `~`；空值返回空串。 */
export function expandHome(value) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (!text) return ''
  if (text === '~') return homedir()
  if (text.startsWith('~/')) return join(homedir(), text.slice(2))
  return text
}

/** 配置文件的绝对路径。 */
export function configFile() {
  const fromEnv = expandHome(process.env[CONFIG_ENV])
  return fromEnv ? resolve(fromEnv) : join(homedir(), '.dsh', 'work-review.json')
}

/** 读配置文件；缺失 / 非法 JSON / 非对象一律返回 {}。 */
export function readConfig() {
  try {
    const file = configFile()
    if (!existsSync(file)) return {}
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  } catch {
    return {}
  }
}

function stringField(config, key) {
  const value = config && typeof config === 'object' ? config[key] : ''
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * vault 根目录：显式参数 > $DSH_WORK_REVIEW_VAULT > 配置文件的 vaultRoot。
 * 都没配置时返回空串（不抛错，host 侧据此降级；CLI 侧据此报错）。
 */
export function resolveVaultRoot(explicit) {
  const fromArg = expandHome(explicit)
  if (fromArg) return resolve(fromArg)
  const fromEnv = expandHome(process.env[VAULT_ENV])
  if (fromEnv) return resolve(fromEnv)
  const fromConfig = expandHome(stringField(readConfig(), 'vaultRoot'))
  if (fromConfig) return resolve(fromConfig)
  return ''
}

/** 未配置 vault 时给人看的一句话（CLI stderr 与面板共用）。 */
export function vaultHint() {
  return [
    '未配置 vault 根目录。三选一：',
    `  1) 命令行 --vault <dir>`,
    `  2) 环境变量 ${VAULT_ENV}=<dir>`,
    `  3) 在 ${configFile()} 里写 {"vaultRoot": "<dir>"}`,
  ].join('\n')
}

/**
 * 面板「一键审批」配置：`{ label, command, autoSend, agentPreset }`，没配置返回 null。
 *
 *   "review": {
 *     "label": "去审批",
 *     "command": "$sleep-review {date}",
 *     "autoSend": false,
 *     "agentPreset": null
 *   }
 *
 * 占位符 `{date} {week} {title} {path} {vault}` 由面板在点击时填充。缺少非空
 * `command` 时整体视为未配置——面板据此不渲染审批按钮，保持纯只读。
 */
export function reviewConfig(config = readConfig()) {
  const source = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const raw =
    source.review && typeof source.review === 'object' && !Array.isArray(source.review)
      ? source.review
      : null
  if (!raw) return null
  const command = stringField(raw, 'command')
  if (!command) return null
  return {
    label: stringField(raw, 'label') || '去审批',
    command,
    autoSend: raw.autoSend === true,
    agentPreset: stringField(raw, 'agentPreset'),
  }
}

/**
 * 面板「执行自动审批」配置：`{ label, python, script, args }`，没配置返回 null。
 *
 *   "approve": {
 *     "label": "执行自动审批",
 *     "python": "/usr/bin/python3",
 *     "script": "scripts/dsh-run-task.py",     // 相对路径按 vaultRoot 解析
 *     "args": ["review", "{date}", "--live"]
 *   }
 *
 * 与 review（新开 session + 提示词）不同，这条走确定性脚本：host 直接 spawn，
 * cwd 固定为 vault。缺少非空 `script` 时整段忽略——面板不渲染这个按钮。
 */
export function approveConfig(config = readConfig()) {
  const source = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const raw =
    source.approve && typeof source.approve === 'object' && !Array.isArray(source.approve)
      ? source.approve
      : null
  if (!raw) return null
  const script = stringField(raw, 'script')
  if (!script) return null
  const args = Array.isArray(raw.args) ? raw.args.filter((item) => typeof item === 'string') : []
  return {
    label: stringField(raw, 'label') || '执行自动审批',
    python: stringField(raw, 'python') || '/usr/bin/python3',
    script,
    args,
  }
}

/** 输出目录：显式参数 > 配置的 outDir > <vault>/life/routines。 */
export function resolveOutDir(explicit, vaultRoot, config = readConfig()) {
  const fromArg = expandHome(explicit)
  if (fromArg) return resolve(fromArg)
  const fromConfig = expandHome(stringField(config, 'outDir'))
  if (fromConfig) return isAbsolute(fromConfig) ? fromConfig : resolve(vaultRoot, fromConfig)
  return join(vaultRoot, 'life', 'routines')
}

/** 缓存目录（日志、被拒输出）：默认 ~/.cache/work-review。 */
export function resolveCacheDir(config = readConfig()) {
  const fromConfig = expandHome(stringField(config, 'cacheDir'))
  return fromConfig ? resolve(fromConfig) : join(homedir(), '.cache', 'work-review')
}

/** DSH CLI 候选路径（是否存在由调用方检查）。 */
export function resolveDshCli(config = readConfig()) {
  const fromEnv = expandHome(process.env.DSH_CLI)
  if (fromEnv) return fromEnv
  const fromConfig = expandHome(stringField(config, 'dshCli'))
  if (fromConfig) return fromConfig
  return ''
}

/** 内建 provider 表：只有 headless profile 的默认模型。 */
export function defaultProviders() {
  return [
    {
      id: DEFAULT_PROVIDER_ID,
      label: 'headless profile 的默认模型',
      keyEnv: '',
      patch: '',
    },
  ]
}

/**
 * 完整 provider 表 = 内建默认 + 配置文件里的高级 provider。
 * 高级 provider 的 patch 可以是绝对路径、`~/...`，或相对 vaultRoot 的路径。
 */
export function resolveProviders({ vaultRoot = '', config = readConfig() } = {}) {
  const list = []
  const raw = Array.isArray(config.providers) ? config.providers : []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    if (!id || id === DEFAULT_PROVIDER_ID || list.some((p) => p.id === id)) continue
    const patch = expandHome(item.patch)
    list.push({
      id,
      label: typeof item.label === 'string' && item.label.trim() ? item.label.trim() : id,
      keyEnv: typeof item.keyEnv === 'string' ? item.keyEnv.trim() : '',
      patch: patch ? (isAbsolute(patch) ? patch : resolve(vaultRoot, patch)) : '',
    })
  }
  // 配置过的 provider 排在前面（显式意图优先），内建默认模型留作最后的兜底。
  list.push(...defaultProviders())
  return list
}
