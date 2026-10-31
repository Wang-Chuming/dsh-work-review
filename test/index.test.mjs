import assert from 'node:assert/strict'
import test from 'node:test'

import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, route } from '../lib/index.js'

/** 等一个条件成立（按钮启动的脚本是异步的）。 */
async function waitFor(predicate, { timeout = 4000, interval = 40 } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}

test('work_review_status registers an object JSON schema', () => {
  let tool
  const ctx = {
    get(name) {
      if (name === 'tools') return { register(definition) { tool = definition } }
      return undefined
    },
    effect(run) { return run() },
    webServer: { register() { return {} } },
  }

  apply(ctx, {})

  assert.equal(tool?.name, 'work_review_status')
  assert.equal(tool?.parameters?.type, 'object')
  assert.deepEqual(Object.keys(tool.parameters.properties), ['week', 'date'])
})

const VAULT = fileURLToPath(new URL('./fixtures/vault/', import.meta.url))

test('/index 返回 review 配置的安全子集，未配置时为 null', () => {
  const base = {
    url: '/work-review/api/index',
    method: 'GET',
    vaultRoot: VAULT,
    today: '2026-10-29',
  }
  const plain = route(base)
  assert.equal(plain.code, 200)
  assert.equal(plain.body.review, null)

  const review = { label: '去审批', command: '$sleep-review {date}', autoSend: false, agentPreset: '' }
  const withReview = route({ ...base, review })
  assert.equal(withReview.code, 200)
  assert.deepEqual(withReview.body.review, review)
  assert.ok(Array.isArray(withReview.body.days))
  assert.ok(Array.isArray(withReview.body.routines))
})

test('/index 返回 approve 的标签子集，未配置时为 null', () => {
  const base = { url: '/work-review/api/index', method: 'GET', vaultRoot: VAULT, today: '2026-10-29' }
  assert.equal(route(base).body.approve, null)

  const approve = { label: '执行自动审批', python: '/usr/bin/python3', script: 'scripts/dsh-run-task.py', args: [] }
  const body = route({ ...base, approve }).body
  assert.deepEqual(body.approve, { label: '执行自动审批', configured: true })
  // 具体的命令不渗到面板层
  assert.equal(body.approve.script, undefined)
})

test('/approve：未配置时 GET 返回 configured:false，POST 拒绝', () => {
  const get = route({ url: '/work-review/api/approve?date=2026-10-30', method: 'GET', vaultRoot: VAULT, cacheDir: '/tmp/x' })
  assert.equal(get.code, 200)
  assert.equal(get.body.configured, false)

  const post = route({
    url: '/work-review/api/approve',
    method: 'POST',
    vaultRoot: VAULT,
    cacheDir: '/tmp/x',
    body: { date: '2026-10-30' },
  })
  assert.equal(post.code, 503)
  assert.equal(post.body.ok, false)
})

test('/approve：GET 校验日期，POST 真的启动脚本并能查到 done', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'wr-index-'))
  const script = join(cacheDir, 'fake.sh')
  writeFileSync(script, '#!/bin/sh\necho index-approve-ok\n', 'utf8')
  chmodSync(script, 0o755)
  const approve = { label: '执行自动审批', python: '/bin/sh', script, args: [] }
  const base = { vaultRoot: VAULT, cacheDir, approve }

  const badDate = route({ ...base, url: '/work-review/api/approve?date=2026-1-1', method: 'GET' })
  assert.equal(badDate.code, 400)

  const started = route({
    ...base,
    url: '/work-review/api/approve',
    method: 'POST',
    body: { date: '2026-10-30' },
  })
  assert.equal(started.code, 200)
  assert.equal(started.body.ok, true)
  assert.equal(started.body.started, true)

  const final = await waitFor(() => {
    const status = route({ ...base, url: '/work-review/api/approve?date=2026-10-30', method: 'GET' })
    return status.body.status === 'done' ? status.body : null
  })
  assert.equal(final.exitCode, 0)
  assert.match(final.tail, /index-approve-ok/)
})

test('/approve：非 GET/POST 返回 405', () => {
  const res = route({
    url: '/work-review/api/approve',
    method: 'DELETE',
    vaultRoot: VAULT,
    cacheDir: '/tmp/x',
    approve: { label: 'x', python: '/bin/sh', script: '/tmp/x.sh', args: [] },
  })
  assert.equal(res.code, 405)
})


// ---------------------------------------------------------------------------
// handler 层：读 POST body → route → spawn（覆盖 readBody，避免只测 route）
// ---------------------------------------------------------------------------

function fakeServer() {
  const state = { handler: null }
  const ctx = {
    get() {
      return undefined
    },
    effect(run) {
      return run()
    },
    webServer: {
      register(definition) {
        state.handler = definition.handler
        return {}
      },
    },
  }
  return { ctx, state }
}

function fakeRequest(method, url, payload) {
  const text = payload === undefined ? '' : JSON.stringify(payload)
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      if (text) yield Buffer.from(text)
    },
  }
}

function fakeResponse() {
  const res = {
    code: null,
    body: null,
    writeHead(code) {
      this.code = code
    },
    end(text) {
      this.body = JSON.parse(text)
    },
  }
  return res
}

/** 用临时配置目录跑 handler（不碰本机 ~/.dsh 与真实缓存）。 */
async function withTempProfile(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'wr-handler-'))
  const cacheDir = join(dir, 'cache')
  const configFile = join(dir, 'work-review.json')
  writeFileSync(configFile, JSON.stringify({ vaultRoot: VAULT, cacheDir }), 'utf8')
  const saved = process.env.DSH_WORK_REVIEW_CONFIG
  process.env.DSH_WORK_REVIEW_CONFIG = configFile
  try {
    return await fn({ dir, cacheDir })
  } finally {
    if (saved === undefined) delete process.env.DSH_WORK_REVIEW_CONFIG
    else process.env.DSH_WORK_REVIEW_CONFIG = saved
  }
}

test('handler：POST /approve 读 body 并启动脚本，GET 能查到 done', async () => {
  await withTempProfile(async ({ dir, cacheDir }) => {
    const script = join(dir, 'approve.sh')
    writeFileSync(script, '#!/bin/sh\necho handler-ok\n', 'utf8')
    chmodSync(script, 0o755)

    const { ctx, state } = fakeServer()
    apply(ctx, {
      vaultRoot: VAULT,
      approve: { label: '执行自动审批', python: '/bin/sh', script, args: [] },
    })
    assert.equal(typeof state.handler, 'function')

    const postRes = fakeResponse()
    await state.handler(fakeRequest('POST', '/work-review/api/approve', { date: '2026-10-30' }), postRes)
    assert.equal(postRes.code, 200)
    assert.equal(postRes.body.started, true)

    let status = null
    const deadline = Date.now() + 4000
    while (Date.now() < deadline) {
      const res = fakeResponse()
      await state.handler(fakeRequest('GET', '/work-review/api/approve?date=2026-10-30'), res)
      status = res.body
      if (status.status === 'done') break
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    assert.equal(status.status, 'done')
    assert.match(status.tail, /handler-ok/)
    assert.ok(cacheDir.startsWith(dir))
  })
})

test('handler：非法 JSON body 返回 500 而不是崩掉', async () => {
  await withTempProfile(async ({ dir }) => {
    const script = join(dir, 'noop.sh')
    writeFileSync(script, '#!/bin/sh\ntrue\n', 'utf8')
    chmodSync(script, 0o755)

    const { ctx, state } = fakeServer()
    apply(ctx, { vaultRoot: VAULT, approve: { label: 'x', python: '/bin/sh', script, args: [] } })

    const req = {
      method: 'POST',
      url: '/work-review/api/approve',
      async *[Symbol.asyncIterator]() {
        yield Buffer.from('{not json')
      },
    }
    const res = fakeResponse()
    await state.handler(req, res)
    assert.equal(res.code, 500)
    assert.equal(res.body.ok, false)
  })
})
