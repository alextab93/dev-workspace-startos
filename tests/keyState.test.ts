import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { types } from '@start9labs/start-sdk'
import {
  keyFiles,
  type KeyFiles,
  type KeyStore,
  type SshKey,
} from '../startos/fileModels/store.json'
import {
  changeKeys,
  getKeyStatus,
  newKeyStore,
  parseKeyStore,
  readKeyStore,
  renderKeys,
  synchronizeKeys,
} from '../startos/keyState'
import { parsePublicKey } from '../startos/sshKeys'

let directory: string
let firstKey: SshKey
let secondKey: SshKey
before(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), 'dev-workspace-key-state-'))
  firstKey = await generate('first')
  secondKey = await generate('second')
})
after(() => fs.rm(directory, { recursive: true, force: true }))

async function generate(label: string) {
  const path = join(directory, label)
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path])
  return { label, ...parsePublicKey(await fs.readFile(`${path}.pub`, 'utf8')) }
}

const linuxOnly = {
  skip:
    process.platform === 'linux'
      ? false
      : 'SDK atomic writes require Linux flock and /proc.',
}

async function filesForTest(): Promise<KeyFiles> {
  const root = await fs.mkdtemp(join(directory, 'case-'))
  const source = join(root, 'store.json')
  return {
    store: keyFiles.store.withPath(source),
    source: keyFiles.source.withPath(source),
    authorized: keyFiles.authorized.withPath(join(root, 'authorized_keys')),
    applied: keyFiles.applied.withPath(join(root, 'applied.json')),
  }
}

async function replace(path: string, contents: string) {
  const temporary = `${path}.${randomUUID()}.tmp`
  await fs.writeFile(temporary, contents)
  await fs.rename(temporary, path)
}

async function writeState(files: KeyFiles, state: KeyStore) {
  await replace(files.source.path, JSON.stringify(state))
}

async function writeApplied(files: KeyFiles, state: KeyStore) {
  await replace(
    files.applied.path,
    JSON.stringify({
      generation: state.generation,
      revision: state.revision,
    }),
  )
  await replace(files.authorized.path, renderKeys(state.keys))
}

function effectsBoundary() {
  return {
    isInContext: true,
    onLeaveContext() {},
  } as types.Effects
}

async function observe<T>(read: (effects: types.Effects) => Promise<T>) {
  const effects = effectsBoundary()
  let value: T | undefined
  let error: unknown
  let pending = Promise.resolve()
  const run = async () => {
    try {
      value = await read(effects)
      error = undefined
    } catch (failure) {
      error = failure
    }
  }
  effects.constRetry = () => {
    pending = pending.then(run)
  }
  await run()
  return {
    get value() {
      return value
    },
    get error() {
      return error
    },
    async close() {
      effects.isInContext = false
      await pending
    },
  }
}

async function eventually(condition: () => boolean | Promise<boolean>) {
  const end = Date.now() + 3000
  while (Date.now() < end) {
    if (await condition()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail('The expected persisted state did not become available.')
}

test('new configuration generations prevent reused revision identities', () => {
  const first = newKeyStore()
  const second = newKeyStore()
  assert.deepEqual(first.keys, [])
  assert.equal(first.revision, 0)
  assert.notEqual(first.generation, second.generation)
  assert.deepEqual(parseKeyStore(JSON.stringify(first)), first)
})

test('rejects missing, corrupt, inconsistent, and duplicated persisted keys', () => {
  assert.throws(() => parseKeyStore(null), /configuration is missing/)
  assert.throws(() => parseKeyStore('{ invalid'), /configuration is invalid/)
  assert.throws(
    () => parseKeyStore(JSON.stringify({ generation: randomUUID(), keys: [] })),
    /configuration is invalid/,
  )
  for (const keys of [
    [{ ...firstKey, fingerprint: secondKey.fingerprint }],
    [{ ...firstKey, type: 'ssh-rsa' }],
    [{ ...firstKey, publicKey: 'invalid' }],
    [firstKey, firstKey],
  ]) {
    assert.throws(
      () => parseKeyStore(JSON.stringify({ ...newKeyStore(), keys })),
      /configuration is invalid/,
    )
  }
})

test('reactive source reads recover after malformed JSON, invalid schema, and deletion', async (context) => {
  const files = await filesForTest()
  const initial = { ...newKeyStore(), keys: [firstKey] }
  await writeState(files, initial)
  const observed = await observe((effects) => readKeyStore(effects, files))
  context.after(() => observed.close())
  assert.deepEqual(observed.value, initial)
  for (const corruption of ['{ invalid', '{"keys": false}', null]) {
    if (corruption === null) await fs.unlink(files.source.path)
    else await replace(files.source.path, corruption)
    await eventually(() => observed.error instanceof Error)
    const repaired = { ...initial, keys: [secondKey], revision: 2 }
    await writeState(files, repaired)
    await eventually(() => observed.error === undefined)
    assert.deepEqual(observed.value, repaired)
  }
})

test('health distinguishes missing setup, invalid configuration, and unapplied keys', async () => {
  const files = await filesForTest()
  await assert.rejects(getKeyStatus(files), /configuration is missing/)
  await replace(files.source.path, '{ invalid')
  await assert.rejects(getKeyStatus(files), /configuration is invalid/)
  const empty = newKeyStore()
  await writeState(files, empty)
  assert.deepEqual(await getKeyStatus(files), { keys: 0, synchronized: false })
  await writeApplied(files, empty)
  assert.deepEqual(await getKeyStatus(files), { keys: 0, synchronized: true })
  const populated = { ...empty, keys: [firstKey], revision: 1 }
  await writeState(files, populated)
  assert.deepEqual(await getKeyStatus(files), { keys: 1, synchronized: false })
  await writeApplied(files, populated)
  assert.deepEqual(await getKeyStatus(files), { keys: 1, synchronized: true })
  await replace(files.authorized.path, renderKeys([secondKey]))
  assert.deepEqual(await getKeyStatus(files), { keys: 1, synchronized: false })
  await writeApplied(files, { ...populated, generation: randomUUID() })
  assert.deepEqual(await getKeyStatus(files), { keys: 1, synchronized: false })
  await replace(files.applied.path, '{ invalid')
  assert.deepEqual(await getKeyStatus(files), { keys: 1, synchronized: false })
})

test(
  'synchronization revokes corrupt state and recovers after repair',
  linuxOnly,
  async (context) => {
    const files = await filesForTest()
    const initial = { ...newKeyStore(), keys: [firstKey] }
    await writeState(files, initial)
    const observed = await observe((effects) => synchronizeKeys(effects, files))
    context.after(() => observed.close())
    assert.deepEqual(await getKeyStatus(files), { keys: 1, synchronized: true })
    await replace(files.source.path, '{ invalid')
    await eventually(
      async () => (await fs.readFile(files.authorized.path, 'utf8')) === '',
    )
    await eventually(() => observed.error instanceof Error)
    await assert.rejects(getKeyStatus(files), /configuration is invalid/)
    const repaired = { ...initial, keys: [secondKey], revision: 1 }
    await writeState(files, repaired)
    await eventually(async () => (await getKeyStatus(files)).synchronized)
    assert.equal(
      await fs.readFile(files.authorized.path, 'utf8'),
      renderKeys([secondKey]),
    )
    await eventually(() => observed.error === undefined)
    assert.equal(observed.error, undefined)
  },
)

test(
  'a receipt from deleted configuration cannot acknowledge a new key',
  linuxOnly,
  async () => {
    const files = await filesForTest()
    const previous = { ...newKeyStore(), keys: [firstKey], revision: 100 }
    await writeApplied(files, previous)
    await assert.rejects(
      changeKeys(effectsBoundary(), () => [secondKey], files, 150),
      /change was saved but SSH synchronization has not completed/,
    )
    const persisted = parseKeyStore(
      await fs.readFile(files.source.path, 'utf8'),
    )
    assert.deepEqual(persisted.keys, [secondKey])
    assert.equal(persisted.revision, 1)
    assert.notEqual(persisted.generation, previous.generation)
    assert.equal(
      await fs.readFile(files.authorized.path, 'utf8'),
      renderKeys([firstKey]),
    )
    assert.deepEqual(await getKeyStatus(files), {
      keys: 1,
      synchronized: false,
    })
  },
)

test(
  'concurrent key changes preserve both identities and acknowledge applied results',
  linuxOnly,
  async (context) => {
    const files = await filesForTest()
    await writeState(files, newKeyStore())
    const observed = await observe((effects) => synchronizeKeys(effects, files))
    context.after(() => observed.close())
    await Promise.all([
      changeKeys(effectsBoundary(), (keys) => [...keys, firstKey], files, 3000),
      changeKeys(
        effectsBoundary(),
        (keys) => [...keys, secondKey],
        files,
        3000,
      ),
    ])
    const persisted = parseKeyStore(
      await fs.readFile(files.source.path, 'utf8'),
    )
    assert.deepEqual(
      persisted.keys.map((key) => key.fingerprint).sort(),
      [firstKey.fingerprint, secondKey.fingerprint].sort(),
    )
    assert.deepEqual(await getKeyStatus(files), { keys: 2, synchronized: true })
    assert.equal(
      await fs.readFile(files.authorized.path, 'utf8'),
      renderKeys(persisted.keys),
    )
  },
)

test(
  'failed authorization writes do not produce successful receipts',
  linuxOnly,
  async () => {
    const files = await filesForTest()
    const state = { ...newKeyStore(), keys: [firstKey], revision: 1 }
    await writeState(files, state)
    await fs.mkdir(files.authorized.path)
    await assert.rejects(synchronizeKeys(effectsBoundary(), files))
    await assert.rejects(fs.readFile(files.applied.path, 'utf8'), {
      code: 'ENOENT',
    })
    assert.deepEqual(
      parseKeyStore(await fs.readFile(files.source.path, 'utf8')),
      state,
    )
  },
)

test(
  'failed receipt writes report incomplete synchronization with the saved key set',
  linuxOnly,
  async () => {
    const files = await filesForTest()
    const initial = { ...newKeyStore(), keys: [firstKey] }
    await writeState(files, initial)
    await writeApplied(files, initial)
    await fs.unlink(files.applied.path)
    await fs.mkdir(files.applied.path)
    await assert.rejects(
      changeKeys(effectsBoundary(), () => [secondKey], files, 150),
      /change was saved but SSH synchronization has not completed/,
    )
    assert.equal(
      await fs.readFile(files.authorized.path, 'utf8'),
      renderKeys([firstKey]),
    )
    await assert.rejects(synchronizeKeys(effectsBoundary(), files))
    assert.equal(
      await fs.readFile(files.authorized.path, 'utf8'),
      renderKeys([secondKey]),
    )
    assert.deepEqual(
      parseKeyStore(await fs.readFile(files.source.path, 'utf8')).keys,
      [secondKey],
    )
    assert.deepEqual(await getKeyStatus(files), {
      keys: 1,
      synchronized: false,
    })
  },
)
