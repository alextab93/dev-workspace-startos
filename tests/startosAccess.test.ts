import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { T } from '@start9labs/start-sdk'
import { startosAccessSource } from '../startos/fileModels/startosAccess.json'
import { initializeStartosAccess } from '../startos/startosAccess'

const linuxOnly = {
  skip:
    process.platform === 'linux'
      ? false
      : 'SDK atomic writes require Linux flock and /proc.',
}

const effects = { isInContext: true, onLeaveContext() {} } as T.Effects

test(
  'ordinary initialization preserves legacy login selection',
  linuxOnly,
  async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'workspace-access-'))
    try {
      const source = startosAccessSource.withPath(
        join(directory, 'access.json'),
      )
      for (const kind of ['install', null, 'update'] as const) {
        await initializeStartosAccess(effects, kind, source)
        assert.deepEqual(JSON.parse(await fs.readFile(source.path, 'utf8')), {
          version: 1,
          restoreGeneration: null,
        })
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  },
)

test(
  'each restore selects a fresh identity and restarts preserve its selection',
  linuxOnly,
  async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'workspace-access-'))
    try {
      const source = startosAccessSource.withPath(
        join(directory, 'access.json'),
      )
      await initializeStartosAccess(effects, 'restore', source)
      const first = JSON.parse(await fs.readFile(source.path, 'utf8'))
      assert.match(first.restoreGeneration, /^[0-9a-f-]{36}$/)
      for (const kind of [null, 'update'] as const) {
        await initializeStartosAccess(effects, kind, source)
        assert.deepEqual(
          JSON.parse(await fs.readFile(source.path, 'utf8')),
          first,
        )
      }
      await initializeStartosAccess(effects, 'restore', source)
      const second = JSON.parse(await fs.readFile(source.path, 'utf8'))
      assert.match(second.restoreGeneration, /^[0-9a-f-]{36}$/)
      assert.notEqual(second.restoreGeneration, first.restoreGeneration)
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  },
)

test(
  'malformed access state cannot reactivate legacy identities',
  linuxOnly,
  async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'workspace-access-'))
    try {
      const source = startosAccessSource.withPath(
        join(directory, 'access.json'),
      )
      for (const raw of [
        'null',
        '{}',
        '{',
        '{"version":1,"restoreGeneration":"../old"}',
      ]) {
        await fs.writeFile(source.path, raw)
        await assert.rejects(initializeStartosAccess(effects, null, source))
        assert.equal(await fs.readFile(source.path, 'utf8'), raw)
      }
      await initializeStartosAccess(effects, 'restore', source)
      const restored = JSON.parse(await fs.readFile(source.path, 'utf8'))
      assert.match(restored.restoreGeneration, /^[0-9a-f-]{36}$/)
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  },
)
