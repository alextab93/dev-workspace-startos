import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { T } from '@start9labs/start-sdk'
import {
  configureDockerSettings,
  defaultDockerConfig,
  dockerConfigFiles,
  parseDockerConfig,
  readDockerConfig,
  type DockerConfigFiles,
} from '../startos/docker'

import { configureDocker } from '../startos/actions/docker'

let directory: string
before(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), 'dev-workspace-docker-'))
})
after(() => fs.rm(directory, { recursive: true, force: true }))

const linuxOnly = {
  skip:
    process.platform === 'linux'
      ? false
      : 'SDK atomic writes require Linux flock and /proc.',
}

async function filesForTest(): Promise<DockerConfigFiles> {
  const root = await fs.mkdtemp(join(directory, 'case-'))
  const path = join(root, 'docker.json')
  return {
    store: dockerConfigFiles.store.withPath(path),
    source: dockerConfigFiles.source.withPath(path),
  }
}

function effectsBoundary(
  status: unknown = { desired: { main: 'stopped' }, started: null },
) {
  return {
    isInContext: true,
    onLeaveContext() {},
    getStatus: async () => status,
  } as unknown as T.Effects
}

test('a new workspace leaves Docker disabled with bounded cleanup defaults', async () => {
  assert.deepEqual(parseDockerConfig(null), {
    enabled: false,
    cleanupAgeHours: 168,
  })
  assert.deepEqual(parseDockerConfig('{}'), defaultDockerConfig)
  const files = await filesForTest()
  assert.deepEqual(
    await readDockerConfig(undefined, files),
    defaultDockerConfig,
  )
  await assert.rejects(fs.readFile(files.source.path), { code: 'ENOENT' })
})

test('configuration preserves future fields and accepts both supported boundaries', () => {
  for (const value of [
    {
      enabled: true,
      cacheBudgetGiB: 1,
      cleanupAgeHours: 24,
      future: { preserved: true },
    },
    {
      enabled: false,
      cacheBudgetGiB: 1000,
      cleanupAgeHours: 8760,
      future: ['kept'],
    },
  ]) {
    assert.deepEqual(parseDockerConfig(JSON.stringify(value)), value)
  }
})

test('invalid Docker configuration fails without echoing its contents', () => {
  for (const raw of [
    'private-config-value',
    'null',
    '[]',
    '{"enabled":"true"}',
    '{"enabled":null}',
    '{"cleanupAgeHours":23}',
    '{"cleanupAgeHours":8761}',
    '{"cleanupAgeHours":24.5}',
  ]) {
    assert.throws(() => parseDockerConfig(raw), {
      message:
        'Podman settings are invalid. Stop Dev Workspace and use Configure Containers.',
    })
  }
})

test('a client using the original container form reaches the stopped-workspace check', async () => {
  const effects = effectsBoundary({
    desired: { main: 'running' },
    started: true,
  })
  await configureDocker.getInput({ effects, prefill: null })
  const legacyInput = { enabled: true, cleanupAgeHours: 168 }
  await assert.rejects(
    configureDocker.run({
      effects,
      input: legacyInput as typeof configureDocker._INPUT,
    }),
    { message: 'Stop Dev Workspace before changing container settings.' },
  )
})

test('configuration changes are refused while running, starting, stopping, or unobservable', async () => {
  for (const status of [
    null,
    { desired: { main: 'running' }, started: '2026-11-15T12:00:00Z' },
    { desired: { main: 'running' }, started: null },
    { desired: { main: 'stopped' }, started: '2026-11-15T12:00:00Z' },
  ]) {
    const files = await filesForTest()
    const before = JSON.stringify(defaultDockerConfig)
    await fs.writeFile(files.source.path, before)
    await assert.rejects(
      configureDockerSettings(
        effectsBoundary(status),
        { ...defaultDockerConfig, enabled: true },
        files,
      ),
      {
        message: 'Stop Dev Workspace before changing container settings.',
      },
    )
    assert.equal(await fs.readFile(files.source.path, 'utf8'), before)
  }
})

test(
  'stopped Docker configuration changes preserve other service settings and future fields',
  linuxOnly,
  async () => {
    const files = await filesForTest()
    const root = join(files.source.path, '..')
    const siblings = {
      'project-source.json':
        '{"provider":"nextcloud","accountId":"existing-account"}',
      'store.json': '{"keys":[{"label":"Existing trusted device"}]}',
    }
    for (const [name, bytes] of Object.entries(siblings)) {
      await fs.writeFile(join(root, name), bytes)
    }
    await fs.writeFile(
      files.source.path,
      JSON.stringify({ ...defaultDockerConfig, future: { keep: true } }),
    )
    const expected = {
      enabled: true,
      cacheBudgetGiB: 25,
      cleanupAgeHours: 72,
      future: { keep: true },
    }
    assert.deepEqual(
      await configureDockerSettings(
        effectsBoundary(),
        { enabled: true, cacheBudgetGiB: 25, cleanupAgeHours: 72 },
        files,
      ),
      expected,
    )
    assert.deepEqual(await readDockerConfig(undefined, files), expected)
    for (const [name, bytes] of Object.entries(siblings)) {
      assert.equal(await fs.readFile(join(root, name), 'utf8'), bytes)
    }
    await configureDockerSettings(
      effectsBoundary(),
      { ...expected, enabled: false },
      files,
    )
    assert.deepEqual(await readDockerConfig(undefined, files), {
      ...expected,
      enabled: false,
    })
  },
)
