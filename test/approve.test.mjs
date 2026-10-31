import assert from 'node:assert/strict'
import test from 'node:test'

import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CONFIG_ENV, approveConfig } from '../lib/config.js'
import { approveStatus, buildCommand, isDate, startApprove } from '../lib/approve.js'

/** 别让用例读本机真实的 ~/.dsh/work-review.json。 */
function withIsolatedConfig(fn) {
  const saved = process.env[CONFIG_ENV]
  process.env[CONFIG_ENV] = join(tmpdir(), 'work-review-nonexistent.json')
  try {
    return fn()
  } finally {
    if (saved === undefined) delete process.env[CONFIG_ENV]
    else process.env[CONFIG_ENV] = saved
  }
}

function tempCache() {
  return mkdtempSync(join(tmpdir(), 'wr-approve-'))
}

/** 造一个可执行的小脚本（`/bin/sh` 直接跑，不依赖 python）。 */
function fakeScript(dir, body) {
  const file = join(dir, 'fake-approve.sh')
  writeFileSync(file, `#!/bin/sh\n${body}\n`, 'utf8')
  chmodSync(file, 0o755)
  return file
}

async function waitFor(predicate, { timeout = 4000, interval = 40 } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}

test('approveConfig：缺省/没有 script 视为未配置，其余字段有默认值', () => {
  withIsolatedConfig(() => {
    assert.equal(approveConfig(), null)
    assert.equal(approveConfig({}), null)
    assert.equal(approveConfig({ approve: null }), null)
    assert.equal(approveConfig({ approve: 'x' }), null)
    assert.equal(approveConfig({ approve: [] }), null)
    assert.equal(approveConfig({ approve: {} }), null)
    assert.equal(approveConfig({ approve: { script: '   ' } }), null)

    assert.deepEqual(approveConfig({ approve: { script: 'scripts/run.py' } }), {
      label: '执行自动审批',
      python: '/usr/bin/python3',
      script: 'scripts/run.py',
      args: [],
    })

    // args 只保留字符串项；label/python 可覆盖
    assert.deepEqual(
      approveConfig({
        approve: {
          label: '一键审批',
          python: '/opt/python3',
          script: 'scripts/run.py',
          args: ['review', '{date}', '--live', 42, null],
        },
      }),
      {
        label: '一键审批',
        python: '/opt/python3',
        script: 'scripts/run.py',
        args: ['review', '{date}', '--live'],
      },
    )
  })
})

test('buildCommand：相对 script 按 vault 解析，占位符展开，空 args 用默认', () => {
  const relative = buildCommand({ script: 'scripts/task.py' }, { date: '2026-10-30', vaultRoot: '/v' })
  assert.equal(relative.command, '/usr/bin/python3')
  assert.deepEqual(relative.args, ['/v/scripts/task.py', 'review', '2026-10-30', '--live'])

  const absolute = buildCommand(
    { python: '/bin/python3', script: '/abs/task.py', args: ['run', '{date}', '{vault}'] },
    { date: '2026-10-30', vaultRoot: '/v' },
  )
  assert.equal(absolute.command, '/bin/python3')
  assert.deepEqual(absolute.args, ['/abs/task.py', 'run', '2026-10-30', '/v'])

  assert.throws(() => buildCommand({}, { date: '2026-10-30', vaultRoot: '/v' }), /script/)
})

test('isDate 只接受 YYYY-MM-DD', () => {
  assert.equal(isDate('2026-10-30'), true)
  assert.equal(isDate('2026-1-30'), false)
  assert.equal(isDate('../etc/passwd'), false)
  assert.equal(isDate(''), false)
})

test('startApprove：跑完记 done + 退出码 0，日志尾部可读', async () => {
  const cacheDir = tempCache()
  const script = fakeScript(cacheDir, 'echo approved-ok')
  const approve = { label: '执行自动审批', python: '/bin/sh', script, args: [] }

  const started = startApprove({ date: '2026-10-30', cacheDir, approve, vaultRoot: cacheDir })
  assert.equal(started.started, true)
  assert.equal(started.date, '2026-10-30')

  const final = await waitFor(() => {
    const status = approveStatus({ date: '2026-10-30', cacheDir })
    return status.status === 'done' || status.status === 'failed' ? status : null
  })
  assert.equal(final.status, 'done')
  assert.equal(final.exitCode, 0)
  assert.match(final.tail, /approved-ok/)
  assert.ok(final.log.endsWith('approve-2026-10-30.log'))
})

test('startApprove：失败退出码与实际一致', async () => {
  const cacheDir = tempCache()
  const script = fakeScript(cacheDir, 'echo boom >&2; exit 3')
  const approve = { python: '/bin/sh', script, args: [] }

  startApprove({ date: '2026-10-31', cacheDir, approve, vaultRoot: cacheDir })
  const final = await waitFor(() => {
    const status = approveStatus({ date: '2026-10-31', cacheDir })
    return status.status === 'failed' ? status : null
  })
  assert.equal(final.exitCode, 3)
  assert.match(final.tail, /boom/)
})

test('startApprove：同一日期已在跑时不重复启动', async () => {
  const cacheDir = tempCache()
  const script = fakeScript(cacheDir, 'sleep 0.6; echo slow-done')
  const approve = { python: '/bin/sh', script, args: [] }

  const first = startApprove({ date: '2026-11-01', cacheDir, approve, vaultRoot: cacheDir })
  assert.equal(first.started, true)
  await waitFor(() => (approveStatus({ date: '2026-11-01', cacheDir }).pid ? true : null))

  const second = startApprove({ date: '2026-11-01', cacheDir, approve, vaultRoot: cacheDir })
  assert.equal(second.started, false)
  assert.equal(second.status, 'running')

  const final = await waitFor(() => {
    const status = approveStatus({ date: '2026-11-01', cacheDir })
    return status.status === 'done' ? status : null
  })
  assert.equal(final.exitCode, 0)
})

test('startApprove：非法日期直接拒绝，不写文件', () => {
  const cacheDir = tempCache()
  const approve = { python: '/bin/sh', script: '/tmp/x.sh', args: [] }
  assert.throws(() => startApprove({ date: '../evil', cacheDir, approve, vaultRoot: cacheDir }), /YYYY-MM-DD/)
  assert.throws(() => approveStatus({ date: '2026/10/30', cacheDir }), /YYYY-MM-DD/)
})
