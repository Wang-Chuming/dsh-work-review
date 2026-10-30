import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../lib/index.js'

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
