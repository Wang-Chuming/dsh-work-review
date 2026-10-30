/**
 * config.test.mjs — 配置解析（vault 路径、provider 表、目录）的回归测试。
 *
 * 每个用例自己管理环境变量与临时配置文件，互不依赖，也不读本机真实 vault。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import * as config from '../lib/config.js'
import { buildFactsPack } from '../lib/core.js'

const ENV_KEYS = [config.CONFIG_ENV, config.VAULT_ENV, 'DSH_CLI']

/**
 * 在隔离环境里跑一个用例：清空相关 env、把 HOME 指到临时目录（默认配置文件在
 * ~/.dsh/work-review.json，不能让测试读到跑测试那台机器上的真实配置），用完恢复。
 */
function withCleanEnv(fn) {
  const keys = [...ENV_KEYS, 'HOME', 'USERPROFILE']
  const saved = {}
  for (const key of keys) {
    saved[key] = process.env[key]
    if (key !== 'HOME' && key !== 'USERPROFILE') delete process.env[key]
  }
  const dir = mkdtempSync(join(tmpdir(), 'work-review-config-'))
  const home = join(dir, 'home')
  mkdirSync(home, { recursive: true })
  process.env.HOME = home
  process.env.USERPROFILE = home
  try {
    return fn({ dir, home, configFile: join(dir, 'work-review.json') })
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

function writeConfig(file, value) {
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
  process.env[config.CONFIG_ENV] = file
}

test('expandHome 展开 ~ 且对空值/非字符串安全', () => {
  assert.equal(config.expandHome('~'), homedir())
  assert.equal(config.expandHome('~/notes'), join(homedir(), 'notes'))
  assert.equal(config.expandHome('/abs/path'), '/abs/path')
  assert.equal(config.expandHome('relative/path'), 'relative/path')
  assert.equal(config.expandHome(''), '')
  assert.equal(config.expandHome('   '), '')
  assert.equal(config.expandHome(undefined), '')
  assert.equal(config.expandHome(null), '')
})

test('配置文件路径可被 DSH_WORK_REVIEW_CONFIG 覆盖，默认在 ~/.dsh', () => {
  withCleanEnv(({ configFile }) => {
    assert.equal(config.configFile(), join(homedir(), '.dsh', 'work-review.json'))
    process.env[config.CONFIG_ENV] = configFile
    assert.equal(config.configFile(), configFile)
    process.env[config.CONFIG_ENV] = '~/custom/wr.json'
    assert.equal(config.configFile(), join(homedir(), 'custom', 'wr.json'))
  })
})

test('readConfig：缺失、空文件、非法 JSON、数组都降级为空对象', () => {
  withCleanEnv(({ dir, configFile }) => {
    assert.deepEqual(config.readConfig(), {})

    writeConfig(configFile, '')
    assert.deepEqual(config.readConfig(), {})

    writeConfig(configFile, '{ not json')
    assert.deepEqual(config.readConfig(), {})

    writeConfig(configFile, '[]')
    assert.deepEqual(config.readConfig(), {})

    writeConfig(configFile, { vaultRoot: '/v' })
    assert.deepEqual(config.readConfig(), { vaultRoot: '/v' })

    // 显式指向一个不存在的路径也不抛错
    process.env[config.CONFIG_ENV] = join(dir, 'nope.json')
    assert.deepEqual(config.readConfig(), {})
  })
})

test('vault 路径优先级：显式参数 > 环境变量 > 配置文件 > 空串', () => {
  withCleanEnv(({ configFile }) => {
    assert.equal(config.resolveVaultRoot(), '')

    writeConfig(configFile, { vaultRoot: '/from/config' })
    assert.equal(config.resolveVaultRoot(), '/from/config')

    process.env[config.VAULT_ENV] = '/from/env'
    assert.equal(config.resolveVaultRoot(), '/from/env')

    assert.equal(config.resolveVaultRoot('/from/arg'), '/from/arg')

    // ~ 展开
    assert.equal(config.resolveVaultRoot('~/my-vault'), join(homedir(), 'my-vault'))
  })
})

test('vaultHint 指出三种配置方式', () => {
  withCleanEnv(() => {
    const hint = config.vaultHint()
    assert.match(hint, /--vault/)
    assert.match(hint, new RegExp(config.VAULT_ENV))
    assert.match(hint, /work-review\.json/)
  })
})

test('provider 表：默认只有内建 dsh-default；配置的 provider 排在前面', () => {
  withCleanEnv(({ configFile }) => {
    const defaults = config.resolveProviders({ vaultRoot: '/vault' })
    assert.deepEqual(
      defaults.map((p) => p.id),
      [config.DEFAULT_PROVIDER_ID],
    )
    assert.equal(defaults[0].patch, '')
    assert.equal(defaults[0].keyEnv, '')

    writeConfig(configFile, {
      providers: [
        { id: 'custom-headless', label: 'My headless patch', keyEnv: 'MY_HEADLESS_API_KEY', patch: 'patches/custom.yml' },
        { id: 'absolute', patch: '/tmp/abs.yml' },
        { id: 'tilde', patch: '~/patches/tilde.yml' },
        // 重复 id 与占用内建 id 的条目被忽略
        { id: 'custom-headless', patch: '/tmp/dup.yml' },
        { id: config.DEFAULT_PROVIDER_ID, patch: '/tmp/builtin.yml' },
        { patch: '/tmp/no-id.yml' },
        'not-an-object',
      ],
    })

    const list = config.resolveProviders({ vaultRoot: '/vault' })
    assert.deepEqual(
      list.map((p) => p.id),
      ['custom-headless', 'absolute', 'tilde', config.DEFAULT_PROVIDER_ID],
    )
    assert.equal(list[0].label, 'My headless patch')
    assert.equal(list[0].keyEnv, 'MY_HEADLESS_API_KEY')
    // 相对 patch 相对 vaultRoot；绝对路径原样；~ 展开
    assert.equal(list[0].patch, join('/vault', 'patches', 'custom.yml'))
    assert.equal(list[1].patch, '/tmp/abs.yml')
    assert.equal(list[2].patch, join(homedir(), 'patches', 'tilde.yml'))
    assert.equal(list[3].patch, '')
  })
})

test('输出目录：显式 > 配置 outDir > <vault>/life/routines', () => {
  withCleanEnv(({ configFile }) => {
    assert.equal(config.resolveOutDir('', '/vault'), join('/vault', 'life', 'routines'))
    assert.equal(config.resolveOutDir('/out', '/vault'), '/out')

    writeConfig(configFile, { outDir: 'custom/routines' })
    assert.equal(config.resolveOutDir('', '/vault'), join('/vault', 'custom', 'routines'))

    writeConfig(configFile, { outDir: '/abs/routines' })
    assert.equal(config.resolveOutDir('', '/vault'), '/abs/routines')

    assert.equal(config.resolveOutDir('/out', '/vault'), '/out')
  })
})

test('缓存目录与 DSH CLI 路径可配置，默认值不写死用户路径', () => {
  withCleanEnv(({ configFile }) => {
    assert.equal(config.resolveCacheDir(), join(homedir(), '.cache', 'work-review'))
    assert.equal(config.resolveDshCli(), '')

    writeConfig(configFile, { cacheDir: '~/cache/wr', dshCli: '~/bin/dsh' })
    assert.equal(config.resolveCacheDir(), join(homedir(), 'cache', 'wr'))
    assert.equal(config.resolveDshCli(), join(homedir(), 'bin', 'dsh'))

    process.env.DSH_CLI = '/usr/local/bin/dsh'
    assert.equal(config.resolveDshCli(), '/usr/local/bin/dsh')
  })
})

test('未配置 vault 时 buildFactsPack 抛带提示的错误（而不是猜默认路径）', () => {
  withCleanEnv(({ dir }) => {
    process.env[config.CONFIG_ENV] = join(dir, 'missing.json')
    assert.throws(() => buildFactsPack({ week: '2026-W43' }), /未配置 vault/)
    // 显式传了路径就按该路径读（不存在时得到空 facts，而不是回退到别处）
    const pack = buildFactsPack({
      week: '2026-W43',
      vaultRoot: join(dir, 'still-missing'),
      withGit: false,
    })
    assert.equal(pack.coverage.dream, 0)
    assert.equal(pack.coverage.journal, 0)
    assert.equal(pack.gaps.length, 7)
  })
})
