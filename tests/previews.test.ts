import assert from 'node:assert/strict'
import { randomUUID, scryptSync } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { test } from 'node:test'
import type { T } from '@start9labs/start-sdk'
import { previewFiles } from '../startos/fileModels/previews.json'
import {
  addWebPreview,
  emptyPreviewConfig,
  extendWebPreview,
  parsePreviewConfig,
  readPreviewConfig,
  removeWebPreview,
  removeInvalidWebPreviews,
  revokeRestoredPreviews,
  setPreviewPassword,
  validateApplicationPort,
  validatePreviewDuration,
  validatePreviewName,
} from '../startos/previews'

const linuxOnly = {
  skip:
    process.platform === 'linux'
      ? false
      : 'SDK atomic writes require Linux flock and /proc.',
}

async function fixture(
  run: (files: typeof previewFiles, effects: T.Effects) => Promise<void>,
) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'preview-state-'))
  const file = join(directory, 'config.json')
  const files = {
    config: previewFiles.config.withPath(file),
    source: previewFiles.source.withPath(file),
  }
  const effects = { isInContext: true, onLeaveContext() {} } as T.Effects
  try {
    await run(files, effects)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

test('preview input accepts application ports and bounded durations while rejecting internal and malformed targets', () => {
  for (const port of [0, 22, 1023, 2222, 18080, 18087, 65536, 3000.1, NaN])
    assert.throws(() => validateApplicationPort(port))
  for (const port of [1024, 3000, 5173, 65535])
    assert.equal(validateApplicationPort(port), port)
  for (const duration of [0, -1, 1441, 1.5, Infinity])
    assert.throws(() => validatePreviewDuration(duration))
  assert.equal(validatePreviewDuration(60), 60)
  assert.equal(validatePreviewName(' Frontend '), 'Frontend')
  for (const name of ['', ' ', 'a\nb', 'a'.repeat(61)])
    assert.throws(() => validatePreviewName(name))
})

test('invalid or conflicting leases are isolated while unrelated records and unknown fields survive', () => {
  assert.deepEqual(parsePreviewConfig(null), emptyPreviewConfig())
  assert.throws(() => parsePreviewConfig('{broken'), /settings are invalid/)
  const lease = {
    id: randomUUID(),
    name: 'App',
    applicationPort: 3000,
    proxyPort: 18080,
    createdAt: 1000,
    expiresAt: 2000,
  }
  const state = { ...emptyPreviewConfig(), leases: [lease] }
  assert.equal(parsePreviewConfig(JSON.stringify(state)).leases[0].name, 'App')
  const other = {
    ...lease,
    id: randomUUID(),
    name: 'Other',
    applicationPort: 5173,
    proxyPort: 18081,
    futureLeaseSetting: 'retain',
  }
  for (const record of [
    null,
    'invalid',
    { ...lease, expiresAt: null },
    { ...lease, name: ' ', futureField: 'retain' },
    { ...lease, id: randomUUID() },
  ]) {
    const input = {
      ...state,
      leases: [lease, record, other],
      futureSetting: 'keep',
    }
    const actual = parsePreviewConfig(JSON.stringify(input))
    assert.equal(actual.futureSetting, 'keep')
    assert.deepEqual(actual.leases.at(-1), other)
    assert.ok(
      actual.quarantined.some(
        (entry) => JSON.stringify(entry) === JSON.stringify(record),
      ),
    )
    if (record && typeof record === 'object') {
      assert.deepEqual(actual.leases, [other])
      assert.ok(actual.retired.includes(lease.id))
    } else {
      assert.deepEqual(actual.leases, [lease, other])
    }
  }
  const retired = parsePreviewConfig(
    JSON.stringify({ ...state, leases: [lease, other], retired: [lease.id] }),
  )
  assert.deepEqual(retired.leases, [other])
  assert.deepEqual(retired.quarantined, [lease])
  assert.throws(() =>
    parsePreviewConfig(JSON.stringify({ ...state, auth: { hash: 'broken' } })),
  )
})

test(
  'password setup persists only a verifiable salted hash and rotation preserves leases',
  linuxOnly,
  async () => {
    await fixture(async (files, effects) => {
      const password = await setPreviewPassword(effects, files)
      const initial = await readPreviewConfig(undefined, files)
      assert.equal(
        initial.auth!.hash,
        scryptSync(password, initial.auth!.salt, 32).toString('hex'),
      )
      assert.equal(
        (await fs.readFile(files.source.path, 'utf8')).includes(password),
        false,
      )
      const lease = await addWebPreview(
        effects,
        { name: 'Rails', applicationPort: 3000, durationMinutes: 60 },
        files,
      )
      const second = await setPreviewPassword(effects, files)
      const rotated = await readPreviewConfig(undefined, files)
      assert.notEqual(second, password)
      assert.notEqual(rotated.auth!.generation, initial.auth!.generation)
      assert.deepEqual(rotated.leases, [lease])
    })
  },
)

test(
  'valid preview updates preserve damaged records until explicitly removed',
  linuxOnly,
  async () => {
    await fixture(async (files, effects) => {
      await setPreviewPassword(effects, files)
      const first = await addWebPreview(
        effects,
        { name: 'Rails', applicationPort: 3000, durationMinutes: 1 },
        files,
      )
      const second = await addWebPreview(
        effects,
        { name: 'Frontend', applicationPort: 5173, durationMinutes: 60 },
        files,
      )
      const saved = JSON.parse(await fs.readFile(files.source.path, 'utf8'))
      delete saved.quarantined
      const broken = {
        ...second,
        expiresAt: null,
        futureSetting: { value: 'preserved' },
      }
      saved.leases = [first, broken]
      saved.futureSetting = 'preserved'
      const damaged = JSON.stringify(saved)
      await fs.writeFile(files.source.path, damaged)
      const read = await readPreviewConfig(undefined, files)
      assert.deepEqual(read.leases, [first])
      assert.deepEqual(read.quarantined, [broken])
      assert.equal(await fs.readFile(files.source.path, 'utf8'), damaged)
      const extended = await extendWebPreview(effects, first.id, 60, files)
      assert.ok(extended.expiresAt > first.expiresAt)
      const persisted = JSON.parse(await fs.readFile(files.source.path, 'utf8'))
      assert.deepEqual(persisted.leases, [extended])
      assert.deepEqual(persisted.quarantined, [broken])
      assert.deepEqual(persisted.retired, [second.id])
      assert.equal(persisted.futureSetting, 'preserved')
      await assert.rejects(
        addWebPreview(
          effects,
          { name: 'New', applicationPort: 8080, durationMinutes: 60 },
          files,
        ),
        /Remove Invalid/,
      )
      assert.equal(await removeInvalidWebPreviews(effects, files), 1)
      assert.equal(await removeInvalidWebPreviews(effects, files), 0)
      const cleaned = await readPreviewConfig(undefined, files)
      assert.deepEqual(cleaned.leases, [extended])
      assert.deepEqual(cleaned.quarantined, [])
      assert.deepEqual(cleaned.retired, [second.id])
      assert.equal(cleaned.futureSetting, 'preserved')
    })
  },
)

test(
  'adding, extending and removing previews persists the selected lease and preserves other entries',
  linuxOnly,
  async () => {
    await fixture(async (files, effects) => {
      await assert.rejects(
        addWebPreview(
          effects,
          { name: 'Rails', applicationPort: 3000, durationMinutes: 60 },
          files,
        ),
        /Set Web Preview Password/,
      )
      await setPreviewPassword(effects, files)
      const first = await addWebPreview(
        effects,
        { name: 'Rails', applicationPort: 3000, durationMinutes: 1 },
        files,
      )
      const second = await addWebPreview(
        effects,
        { name: 'Vite', applicationPort: 5173, durationMinutes: 60 },
        files,
      )
      const extended = await extendWebPreview(effects, first.id, 60, files)
      assert.ok(extended.expiresAt > first.expiresAt + 58 * 60000)
      assert.deepEqual((await readPreviewConfig(undefined, files)).leases, [
        extended,
        second,
      ])
      await removeWebPreview(effects, first.id, files)
      const state = await readPreviewConfig(undefined, files)
      assert.deepEqual(state.leases, [second])
      assert.deepEqual(state.retired, [first.id])
      await assert.rejects(
        extendWebPreview(effects, first.id, 60, files),
        /expired or was removed/,
      )
      await assert.rejects(
        removeWebPreview(effects, first.id, files),
        /already expired or was removed/,
      )
    })
  },
)

test(
  'duplicate inputs and exhausted capacity preserve the working saved configuration',
  linuxOnly,
  async () => {
    await fixture(async (files, effects) => {
      await setPreviewPassword(effects, files)
      await addWebPreview(
        effects,
        { name: 'Rails', applicationPort: 3000, durationMinutes: 60 },
        files,
      )
      const before = await fs.readFile(files.source.path, 'utf8')
      for (const input of [
        { name: 'rails', applicationPort: 3001, durationMinutes: 60 },
        { name: 'Other', applicationPort: 3000, durationMinutes: 60 },
        { name: 'Bad port', applicationPort: 2222, durationMinutes: 60 },
        { name: 'Long duration', applicationPort: 3001, durationMinutes: 1441 },
      ])
        await assert.rejects(addWebPreview(effects, input, files))
      assert.equal(await fs.readFile(files.source.path, 'utf8'), before)
      await Promise.all(
        Array.from({ length: 7 }, (_, index) =>
          addWebPreview(
            effects,
            {
              name: `App ${index}`,
              applicationPort: 3001 + index,
              durationMinutes: 60,
            },
            files,
          ),
        ),
      )
      const full = await readPreviewConfig(undefined, files)
      assert.equal(full.leases.length, 8)
      assert.equal(new Set(full.leases.map((value) => value.proxyPort)).size, 8)
      await assert.rejects(
        addWebPreview(
          effects,
          { name: 'Overflow', applicationPort: 4000, durationMinutes: 60 },
          files,
        ),
        /Eight previews/,
      )
      assert.deepEqual(await readPreviewConfig(undefined, files), full)
    })
  },
)

test(
  'overlapping creation, renewal and removal preserve surviving leases and never revive a removed preview',
  linuxOnly,
  async () => {
    await fixture(async (files, effects) => {
      await setPreviewPassword(effects, files)
      const removed = await addWebPreview(
        effects,
        { name: 'Remove me', applicationPort: 3000, durationMinutes: 1 },
        files,
      )
      const survivor = await addWebPreview(
        effects,
        { name: 'Keep me', applicationPort: 5173, durationMinutes: 1 },
        files,
      )
      const unchanged = await addWebPreview(
        effects,
        { name: 'Untouched', applicationPort: 8080, durationMinutes: 60 },
        files,
      )
      const before = await readPreviewConfig(undefined, files)
      const [creation, renewal, removal, longExtension, shortExtension] =
        await Promise.allSettled([
          addWebPreview(
            effects,
            { name: 'New app', applicationPort: 4000, durationMinutes: 60 },
            files,
          ),
          extendWebPreview(effects, removed.id, 60, files),
          removeWebPreview(effects, removed.id, files),
          extendWebPreview(effects, survivor.id, 240, files),
          extendWebPreview(effects, survivor.id, 15, files),
        ])
      assert.equal(removal.status, 'fulfilled')
      assert.equal(longExtension.status, 'fulfilled')
      assert.equal(shortExtension.status, 'fulfilled')
      const state = await readPreviewConfig(undefined, files)
      assert.equal(
        state.leases.some((lease) => lease.id === removed.id),
        false,
      )
      assert.deepEqual(state.retired, [removed.id])
      assert.deepEqual(
        state.leases.find((lease) => lease.id === unchanged.id),
        unchanged,
      )
      assert.deepEqual(state.auth, before.auth)
      const current = state.leases.find((lease) => lease.id === survivor.id)!
      assert.equal(current.applicationPort, survivor.applicationPort)
      assert.equal(current.proxyPort, survivor.proxyPort)
      if (longExtension.status === 'fulfilled')
        assert.equal(current.expiresAt, longExtension.value!.expiresAt)
      if (creation.status === 'fulfilled')
        assert.deepEqual(
          state.leases.find((lease) => lease.id === creation.value!.id),
          creation.value,
        )
      else {
        assert.match(String(creation.reason), /cleanup is pending/)
        assert.equal(
          state.leases.some((lease) => lease.applicationPort === 4000),
          false,
        )
      }
      if (renewal.status === 'rejected')
        assert.match(String(renewal.reason), /expired or was removed/)
      await assert.rejects(
        extendWebPreview(effects, removed.id, 60, files),
        /expired or was removed/,
      )
      assert.deepEqual(await readPreviewConfig(undefined, files), state)
    })
  },
)

test(
  'expired lease replacement waits for retirement and receives a new identity',
  linuxOnly,
  async () => {
    await fixture(async (files, effects) => {
      await setPreviewPassword(effects, files)
      const first = await addWebPreview(
        effects,
        { name: 'Rails', applicationPort: 3000, durationMinutes: 60 },
        files,
      )
      await files.config.update(effects, (state) => ({
        ...state!,
        leases: [{ ...first, createdAt: 1000, expiresAt: 2000 }],
      }))
      await assert.rejects(
        extendWebPreview(effects, first.id, 60, files),
        /expired/,
      )
      await assert.rejects(
        addWebPreview(
          effects,
          { name: 'Rails', applicationPort: 3000, durationMinutes: 60 },
          files,
        ),
        /cleanup is pending/,
      )
      await files.config.update(effects, (state) => ({
        ...state!,
        leases: [],
        retired: [],
      }))
      const replacement = await addWebPreview(
        effects,
        { name: 'Rails', applicationPort: 3000, durationMinutes: 60 },
        files,
      )
      assert.notEqual(replacement.id, first.id)
      assert.equal(replacement.proxyPort, first.proxyPort)
      const state = await readPreviewConfig(undefined, files)
      assert.deepEqual(state.leases, [replacement])
      assert.deepEqual(state.retired, [])
    })
  },
)

test(
  'restoring preview state revokes the password and every lease while retaining host identities for cleanup',
  linuxOnly,
  async (t) => {
    await fixture(async (files, effects) => {
      await setPreviewPassword(effects, files)
      const first = await addWebPreview(
        effects,
        { name: 'Rails', applicationPort: 3000, durationMinutes: 60 },
        files,
      )
      const second = await addWebPreview(
        effects,
        { name: 'Vite', applicationPort: 5173, durationMinutes: 60 },
        files,
      )
      await removeWebPreview(effects, first.id, files)
      await files.config.update(effects, (state) => ({
        ...state!,
        futureSetting: 'preserved',
      }))
      await revokeRestoredPreviews(effects, files)
      const restored = await readPreviewConfig(undefined, files)
      assert.equal(restored.auth, null)
      assert.deepEqual(restored.retired, [first.id, second.id])
      assert.deepEqual(restored.leases, [])
      assert.equal(restored.futureSetting, 'preserved')
      t.mock.method(Date, 'now', () => second.createdAt)
      await setPreviewPassword(effects, files)
      await assert.rejects(
        extendWebPreview(effects, second.id, 60, files),
        /expired/,
      )
    })
  },
)

test(
  'restoring a full preview configuration retains every host for cleanup',
  linuxOnly,
  async () => {
    await fixture(async (files, effects) => {
      const retired = Array.from({ length: 128 }, () => randomUUID())
      const leases = Array.from({ length: 8 }, (_, index) => ({
        id: randomUUID(),
        name: `App ${index}`,
        applicationPort: 3000 + index,
        proxyPort: 18080 + index,
        createdAt: 1000,
        expiresAt: 2000,
      }))
      await files.config.update(effects, () => ({
        ...emptyPreviewConfig(),
        leases,
        retired,
      }))
      await revokeRestoredPreviews(effects, files)
      const restored = await readPreviewConfig(undefined, files)
      assert.deepEqual(restored.retired, [
        ...retired,
        ...leases.map((lease) => lease.id),
      ])
      assert.deepEqual(restored.leases, [])
    })
  },
)

test(
  'a denied configuration write preserves the previous grant and recovers after permissions are restored',
  {
    skip:
      process.platform !== 'linux' || process.getuid?.() === 0
        ? 'Requires a non-root Linux filesystem user.'
        : false,
  },
  async () => {
    await fixture(async (files, effects) => {
      await setPreviewPassword(effects, files)
      const lease = await addWebPreview(
        effects,
        { name: 'Rails', applicationPort: 3000, durationMinutes: 1 },
        files,
      )
      const before = await fs.readFile(files.source.path, 'utf8')
      await fs.chmod(dirname(files.source.path), 0o500)
      try {
        await assert.rejects(extendWebPreview(effects, lease.id, 60, files))
        assert.equal(await fs.readFile(files.source.path, 'utf8'), before)
      } finally {
        await fs.chmod(dirname(files.source.path), 0o700)
      }
      const updated = await extendWebPreview(effects, lease.id, 60, files)
      assert.ok(updated.expiresAt > lease.expiresAt)
      assert.deepEqual((await readPreviewConfig(undefined, files)).leases, [
        updated,
      ])
    })
  },
)
