/**
 * approve.js — 「执行自动审批」后台任务。
 *
 * 面板上的按钮不经过会话，而是直接在 vault 里跑脚本（默认
 * `scripts/dsh-run-task.py review <date> --live`），这样和 launchd /
 * 定时任务走的是同一条确定性入口：cwd 固定为 vault、参数固定、不依赖
 * 某个 chat session 的工作目录。
 *
 * 状态放在缓存目录里，host 重启后靠 pid + 状态文件重新对齐：
 *   <cacheDir>/approve-<date>.log   子进程 stdout+stderr（每次启动清空）
 *   <cacheDir>/approve-<date>.json  { status, pid, startedAt, endedAt, exitCode }
 *
 * status 取值：idle | running | done | failed | unknown
 *   unknown = 状态文件说 running，但 pid 已不在（宿主重启或进程被杀，
 *   没有退出码可读）；此时仍把日志尾巴给用户，不假装成功。
 */

import { spawn } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TAIL_LINES = 30
const TAIL_CHARS = 4000
const DEFAULT_ARGS = ['review', '{date}', '--live']
const DEFAULT_PYTHON = '/usr/bin/python3'

/** 校验日期参数：只接受 YYYY-MM-DD，避免拼路径穿越。 */
export function isDate(value) {
  return typeof value === 'string' && DATE_RE.test(value)
}

export function approvePaths(cacheDir, date) {
  const base = join(cacheDir, `approve-${date}`)
  return { log: `${base}.log`, state: `${base}.json` }
}

function readStateFile(file) {
  try {
    if (!existsSync(file)) return null
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null
  } catch {
    return null
  }
}

function writeStateFile(file, value) {
  try {
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  } catch {
    /* 状态文件写不进去不该让按钮崩掉 */
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err && err.code === 'EPERM'
  }
}

/** 日志末尾若干行（超长时按字符截断，面板直接显示）。 */
export function logTail(file) {
  try {
    if (!existsSync(file)) return ''
    const size = statSync(file).size
    if (!size) return ''
    const text = readFileSync(file, 'utf8')
    const lines = text.split('\n').filter((line) => line.trim()).slice(-TAIL_LINES)
    return lines.join('\n').slice(-TAIL_CHARS)
  } catch {
    return ''
  }
}

/** 把配置里的模板参数展开成 argv（`{date}` / `{vault}`）。 */
export function buildCommand(approve, { date, vaultRoot }) {
  const python = (approve && approve.python) || DEFAULT_PYTHON
  const rawScript = approve && typeof approve.script === 'string' ? approve.script.trim() : ''
  if (!rawScript) throw new Error('approve.script 未配置')
  const script = isAbsolute(rawScript) ? rawScript : resolve(vaultRoot, rawScript)
  const template =
    approve && Array.isArray(approve.args) && approve.args.length ? approve.args : DEFAULT_ARGS
  const substitute = (value) =>
    String(value)
      .replace(/\{date\}/g, date)
      .replace(/\{vault\}/g, vaultRoot)
  const args = template.filter((item) => typeof item === 'string').map(substitute)
  return { command: python, args: [script, ...args], script }
}

/** 当前状态（纯读，不启动任何东西）。 */
export function approveStatus({ date, cacheDir }) {
  if (!isDate(date)) throw new Error('date 必须是 YYYY-MM-DD')
  if (!cacheDir) throw new Error('cacheDir 未配置')
  const paths = approvePaths(cacheDir, date)
  const state = readStateFile(paths.state) || {}
  const running = state.status === 'running'
  let status = state.status || 'idle'
  if (running && !pidAlive(state.pid)) status = 'unknown'
  const startedAt = state.startedAt || null
  const endedAt = state.endedAt || null
  const elapsedSec = startedAt
    ? Math.max(0, Math.round(((endedAt ? Date.parse(endedAt) : Date.now()) - Date.parse(startedAt)) / 1000))
    : 0
  return {
    date,
    status,
    pid: running ? state.pid || null : null,
    startedAt,
    endedAt,
    elapsedSec,
    exitCode: Number.isInteger(state.exitCode) ? state.exitCode : null,
    error: state.error || '',
    log: paths.log,
    tail: logTail(paths.log),
  }
}

/**
 * 启动一次自动审批；同一日期已在跑时不重复启动（返回 started:false）。
 * 子进程 detached：host 退出后它继续跑，和定时任务一致。
 */
export function startApprove({ date, cacheDir, approve, vaultRoot, env = process.env }) {
  if (!isDate(date)) throw new Error('date 必须是 YYYY-MM-DD')
  if (!cacheDir) throw new Error('cacheDir 未配置')
  if (!vaultRoot) throw new Error('vaultRoot 未配置')
  const paths = approvePaths(cacheDir, date)
  const current = approveStatus({ date, cacheDir })
  if (current.status === 'running') return { started: false, ...current }

  const { command, args } = buildCommand(approve, { date, vaultRoot })
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(paths.log, '', 'utf8')
  const startedAt = new Date().toISOString()
  writeStateFile(paths.state, { status: 'running', pid: null, startedAt, date })

  let fd
  try {
    fd = openSync(paths.log, 'a')
    const child = spawn(command, args, {
      cwd: vaultRoot,
      detached: true,
      stdio: ['ignore', fd, fd],
      env,
    })
    child.on('error', (err) => {
      writeStateFile(paths.state, {
        status: 'failed',
        pid: child.pid || null,
        startedAt,
        endedAt: new Date().toISOString(),
        exitCode: null,
        error: err instanceof Error ? err.message : String(err),
        date,
      })
    })
    child.on('exit', (code, signal) => {
      writeStateFile(paths.state, {
        status: code === 0 ? 'done' : 'failed',
        pid: child.pid || null,
        startedAt,
        endedAt: new Date().toISOString(),
        exitCode: Number.isInteger(code) ? code : null,
        signal: signal || null,
        date,
      })
    })
    writeStateFile(paths.state, {
      status: 'running',
      pid: child.pid || null,
      startedAt,
      date,
    })
    child.unref()
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* 忽略 */
      }
    }
  }
  return { started: true, ...approveStatus({ date, cacheDir }) }
}
