import assert from 'node:assert/strict'
import test from 'node:test'

import { fileURLToPath } from 'node:url'

import { apply, route } from '../lib/index.js'

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
