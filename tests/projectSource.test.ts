import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { inspect } from 'node:util'
import type { types } from '@start9labs/start-sdk'
import {
  normalizeProjectSubpath,
  normalizeNextcloudUrl,
  buildProjectSource,
  buildNextcloudProjectSource,
  getProjectSourceInput,
  parseProjectSource,
  projectSourceFiles,
  readProjectSource,
  saveProjectSource,
  sourceSchema,
  type ProjectSource,
  type ProjectSourceFiles,
} from '../startos/projectSource'

let directory: string
before(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), 'dev-workspace-project-source-'))
})
after(() => fs.rm(directory, { recursive: true, force: true }))

const linuxOnly = {
  skip:
    process.platform === 'linux'
      ? false
      : 'SDK atomic writes require Linux flock and /proc.',
}

async function filesForTest(): Promise<ProjectSourceFiles> {
  const root = await fs.mkdtemp(join(directory, 'case-'))
  const path = join(root, 'project-source.json')
  return {
    store: projectSourceFiles.store.withPath(path),
    source: projectSourceFiles.source.withPath(path),
  }
}

async function replace(path: string, contents: string) {
  const temporary = `${path}.${randomUUID()}.tmp`
  await fs.writeFile(temporary, contents)
  await fs.rename(temporary, path)
}

function effectsBoundary() {
  return {
    isInContext: true,
    onLeaveContext() {},
  } as types.Effects
}

async function observe(files: ProjectSourceFiles) {
  const effects = effectsBoundary()
  let value: ProjectSource | undefined
  let error: unknown
  let pending = Promise.resolve()
  const run = async () => {
    try {
      value = await readProjectSource(effects, files)
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

async function eventually(condition: () => boolean) {
  const end = Date.now() + 3000
  while (Date.now() < end) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail('The expected project source did not become available.')
}

test('preserves relative Unicode names and spaces exactly', () => {
  for (const value of [
    'projects',
    'My projects/Proyecto número uno',
    '日本語/開発',
    'المشاريع/تطوير',
    'decomposed-e\u0301/folder',
    ' leading space/trailing space ',
    '.hidden/repo-name_1.2',
  ]) {
    assert.equal(normalizeProjectSubpath(value), value)
    assert.deepEqual(
      sourceSchema.parse({ provider: 'filebrowser', subpath: value }),
      { provider: 'filebrowser', subpath: value },
    )
  }
})

test('rejects provider roots, absolute paths, traversal, separators, and controls', () => {
  for (const value of [
    '',
    '   ',
    '/',
    '/projects',
    'C:/projects',
    'C:projects',
    '\\projects',
    'projects\\repo',
    '.',
    '..',
    './projects',
    '../projects',
    'projects/./repo',
    'projects/../repo',
    'projects/',
    'projects//repo',
    'projects/ /repo',
    'projects/\u0000repo',
    'projects/\nrepo',
    'projects/\trepo',
    'projects/\u007frepo',
    'projects/\u0085repo',
    'projects/\u202erepo',
    'projects/\u2028repo',
  ]) {
    assert.throws(
      () => normalizeProjectSubpath(value),
      /nonempty relative folder/,
    )
    assert.throws(() =>
      sourceSchema.parse({ provider: 'filebrowser', subpath: value }),
    )
  }
})

test('missing settings select no provider and supported settings round trip', () => {
  assert.deepEqual(parseProjectSource(null), { provider: 'none' })
  for (const source of [
    { provider: 'none' },
    { provider: 'filebrowser', subpath: 'Projects/my project' },
    {
      provider: 'nextcloud',
      url: 'https://cloud.example/remote.php/dav/files/developer/',
      username: 'developer',
      appPassword: 'fixture-app-password',
      subpath: 'Projects/my project',
    },
  ]) {
    assert.deepEqual(parseProjectSource(JSON.stringify(source)), source)
  }
})

const nextcloudSource = {
  provider: 'nextcloud' as const,
  url: 'https://cloud.example/remote.php/dav/files/developer/',
  username: 'developer',
  appPassword: 'fixture-app-password',
  subpath: 'Projects/my project',
}

test('normalizes the Nextcloud WebDAV root without exposing credentials', () => {
  assert.equal(
    normalizeNextcloudUrl(
      'https://CLOUD.example:443/remote.php/dav/files/developer',
    ),
    nextcloudSource.url,
  )
  assert.equal(
    normalizeNextcloudUrl(
      'https://cloud.example/nextcloud/remote.php/dav/files/Fran%C3%A7ois/',
    ),
    'https://cloud.example/nextcloud/remote.php/dav/files/Fran%C3%A7ois/',
  )
  for (const url of [
    'http://cloud.example/remote.php/dav/files/developer/',
    'https://developer:secret@cloud.example/remote.php/dav/files/developer/',
    'https://cloud.example/remote.php/dav/files/developer/?password=secret',
    'https://cloud.example/remote.php/dav/files/developer/#secret',
    'https://cloud.example/remote.php/dav/',
    'https://cloud.example/remote.php/dav/files/developer/projects/',
    'https://cloud.example/remote.php/dav/files/%2Fadmin/',
    'https://cloud.example/remote.php/dav/files/%5Cadmin/',
    'https://cloud.example/remote.php/dav/files/%00/',
    ' https://cloud.example/remote.php/dav/files/developer/',
    'https://cloud.example/remote.php/dav/files/developer/\n',
  ]) {
    assert.throws(() => normalizeNextcloudUrl(url), /complete HTTPS WebDAV URL/)
  }
})

test('Nextcloud source selection asks for no manual connection fields', () => {
  assert.deepEqual(getProjectSourceInput(nextcloudSource), {
    selection: 'nextcloud',
    value: {},
  })
  for (const current of [
    null,
    nextcloudSource,
    { provider: 'none' as const },
  ]) {
    assert.throws(
      () => buildProjectSource({ selection: 'nextcloud', value: {} }, current),
      /Connect your Nextcloud account/,
    )
  }
})

const connectedAccount = {
  id: 'connection-first',
  url: 'https://cloud.example/remote.php/dav/files/developer/',
  username: 'developer@example.invalid',
  appPassword: 'browser-approved-password',
  accountId: 'developer',
}

test('a browser-approved account creates a project source without manual credentials', () => {
  const source = buildNextcloudProjectSource(
    connectedAccount,
    'Projects/My App',
    null,
  )
  assert.deepEqual(source, {
    provider: 'nextcloud',
    url: connectedAccount.url,
    username: connectedAccount.username,
    appPassword: connectedAccount.appPassword,
    subpath: 'Projects/My App',
    discovery: 'startos',
    accountId: 'developer',
    connectionId: connectedAccount.id,
    cacheIdentity: {
      url: connectedAccount.url,
      username: connectedAccount.username,
      subpath: 'Projects/My App',
    },
  })
  assert.deepEqual(getProjectSourceInput(source), {
    selection: 'nextcloud',
    value: {},
  })
})

test('reauthorizing the same local account preserves its original cache identity', () => {
  const original = buildNextcloudProjectSource(
    connectedAccount,
    'Projects/App',
    null,
  )
  const replacement = buildNextcloudProjectSource(
    {
      ...connectedAccount,
      id: 'connection-second',
      username: 'developer',
      appPassword: 'new-app-password',
    },
    'Projects/App',
    original,
  )
  assert.equal(replacement.provider, 'nextcloud')
  if (replacement.provider !== 'nextcloud' || original.provider !== 'nextcloud')
    throw new Error('Unexpected source')
  assert.deepEqual(replacement.cacheIdentity, original.cacheIdentity)
  assert.equal(replacement.username, 'developer')
  assert.equal(replacement.appPassword, 'new-app-password')
  assert.equal(replacement.connectionId, 'connection-second')
  const other = buildNextcloudProjectSource(
    {
      ...connectedAccount,
      id: 'connection-other',
      accountId: 'someone-else',
      username: 'someone-else',
      url: 'https://cloud.example/remote.php/dav/files/someone-else/',
    },
    'Projects/App',
    original,
  )
  if (other.provider !== 'nextcloud') throw new Error('Unexpected source')
  assert.notDeepEqual(other.cacheIdentity, original.cacheIdentity)
})

test('legacy or different-server identities are not silently reused for browser connections', () => {
  const original = buildNextcloudProjectSource(
    connectedAccount,
    'Projects/App',
    null,
  )
  const changed = buildNextcloudProjectSource(
    {
      ...connectedAccount,
      url: 'https://another.example/remote.php/dav/files/developer/',
    },
    'Projects/App',
    original,
  )
  const legacy = buildNextcloudProjectSource(
    connectedAccount,
    'Projects/App',
    nextcloudSource,
  )
  if (changed.provider !== 'nextcloud' || legacy.provider !== 'nextcloud')
    throw new Error('Unexpected source')
  assert.equal(
    changed.cacheIdentity?.url,
    'https://another.example/remote.php/dav/files/developer/',
  )
  assert.equal(legacy.cacheIdentity?.username, connectedAccount.username)
  assert.equal(nextcloudSource.username, 'developer')
})

test('browser authorization for the verified local legacy account recovers its existing cache identity', () => {
  const legacy = {
    ...nextcloudSource,
    url: 'https://192.0.2.10:60946/remote.php/dav/files/developer/',
    appPassword: 'revoked-legacy-password',
    subpath: 'Projects/App',
  }
  const account = {
    ...connectedAccount,
    url: 'https://10.0.3.1:60946/remote.php/dav/files/developer/',
  }
  const source = buildNextcloudProjectSource(account, legacy.subpath, legacy, [
    'https://10.0.3.1:60946',
    'https://192.0.2.10:60946',
  ])
  if (source.provider !== 'nextcloud') throw new Error('Unexpected source')
  assert.deepEqual(source.cacheIdentity, {
    url: legacy.url,
    username: legacy.username,
    subpath: legacy.subpath,
  })
  assert.equal(source.url, account.url)
  assert.equal(source.username, account.username)
  assert.equal(source.appPassword, account.appPassword)
  assert.equal(source.accountId, account.accountId)
  assert.equal(source.connectionId, account.id)
})

test('legacy adoption compares the decoded WebDAV account ID and preserves the exact original cache identity', () => {
  const legacy = {
    ...nextcloudSource,
    url: 'https://192.0.2.10:60946/remote.php/dav/files/Fran%C3%A7ois/',
    username: 'old-login@example.invalid',
  }
  const account = {
    ...connectedAccount,
    url: 'https://10.0.3.1:60946/remote.php/dav/files/Fran%C3%A7ois/',
    accountId: 'François',
    username: 'new-login@example.invalid',
  }
  const source = buildNextcloudProjectSource(account, legacy.subpath, legacy, [
    'https://192.0.2.10:60946',
  ])
  if (source.provider !== 'nextcloud') throw new Error('Unexpected source')
  assert.deepEqual(source.cacheIdentity, {
    url: legacy.url,
    username: legacy.username,
    subpath: legacy.subpath,
  })
})

test('legacy adoption rejects unknown origins, different accounts, prefixes, and incomplete account paths', () => {
  const account = {
    ...connectedAccount,
    url: 'https://10.0.3.1:60946/remote.php/dav/files/developer/',
    username: nextcloudSource.username,
  }
  for (const legacyUrl of [
    'https://external.example/remote.php/dav/files/developer/',
    'https://192.0.2.10:60946/remote.php/dav/files/someone-else/',
    'https://192.0.2.10:60946/nextcloud/remote.php/dav/files/developer/',
    'https://192.0.2.10:60946/remote.php/dav/files/developer/another/',
    'https://192.0.2.10:60946/remote.php/dav/files/developer',
  ]) {
    const source = buildNextcloudProjectSource(
      account,
      nextcloudSource.subpath,
      { ...nextcloudSource, url: legacyUrl },
      ['https://192.0.2.10:60946'],
    )
    if (source.provider !== 'nextcloud') throw new Error('Unexpected source')
    assert.deepEqual(source.cacheIdentity, {
      url: account.url,
      username: account.username,
      subpath: nextcloudSource.subpath,
    })
  }
})

test('choosing another folder after verified legacy adoption keeps a distinct cache destination', () => {
  const legacy = {
    ...nextcloudSource,
    url: 'https://192.0.2.10:60946/remote.php/dav/files/developer/',
    subpath: 'Projects/Old',
  }
  const source = buildNextcloudProjectSource(
    connectedAccount,
    'Projects/New',
    legacy,
    ['https://192.0.2.10:60946'],
  )
  if (source.provider !== 'nextcloud') throw new Error('Unexpected source')
  assert.deepEqual(source.cacheIdentity, {
    url: legacy.url,
    username: legacy.username,
    subpath: 'Projects/New',
  })
})

test('browser connection metadata must be complete and match its selected folder', () => {
  const valid = buildNextcloudProjectSource(
    connectedAccount,
    'Projects/App',
    null,
  )
  for (const field of [
    'discovery',
    'accountId',
    'connectionId',
    'cacheIdentity',
  ]) {
    const invalid = { ...valid } as Record<string, unknown>
    delete invalid[field]
    assert.equal(sourceSchema.safeParse(invalid).success, false)
  }
  for (const invalid of [
    { ...valid, accountId: '../another' },
    { ...valid, accountId: '..' },
    { ...valid, connectionId: 'bad/id' },
    {
      ...valid,
      cacheIdentity: {
        url: connectedAccount.url,
        username: connectedAccount.username,
        subpath: 'Another',
      },
    },
  ])
    assert.equal(sourceSchema.safeParse(invalid).success, false)
  assert.deepEqual(sourceSchema.parse(nextcloudSource), nextcloudSource)
})

test('invalid selected folders do not reveal browser credentials', () => {
  for (const subpath of ['', '../outside', '/Projects', 'Projects//App']) {
    assert.throws(
      () => buildNextcloudProjectSource(connectedAccount, subpath, null),
      (error: Error) => {
        assert.match(error.message, /account connection is invalid/)
        assert.equal(
          error.message.includes(connectedAccount.appPassword),
          false,
        )
        return true
      },
    )
  }
  assert.deepEqual(
    buildProjectSource({ selection: 'none', value: {} }, nextcloudSource),
    { provider: 'none' },
  )
  assert.deepEqual(
    buildProjectSource(
      { selection: 'filebrowser', value: { subpath: 'projects' } },
      nextcloudSource,
    ),
    { provider: 'filebrowser', subpath: 'projects' },
  )
})

test(
  'persists Nextcloud credentials while returning redacted form values',
  linuxOnly,
  async () => {
    const files = await filesForTest()
    await saveProjectSource(effectsBoundary(), nextcloudSource, files)
    const source = await readProjectSource(undefined, files)
    assert.deepEqual(source, nextcloudSource)
    assert.deepEqual(
      JSON.parse(await fs.readFile(files.source.path, 'utf8')),
      nextcloudSource,
    )
    const form = getProjectSourceInput(source)
    assert.equal(
      JSON.stringify(form).includes(nextcloudSource.appPassword),
      false,
    )
    await saveProjectSource(effectsBoundary(), { provider: 'none' }, files)
    assert.deepEqual(JSON.parse(await fs.readFile(files.source.path, 'utf8')), {
      provider: 'none',
    })
  },
)

test('corrupt settings report the stopped-service recovery action', () => {
  for (const raw of [
    '',
    '{ invalid',
    'null',
    '[]',
    '{}',
    '{"provider":false}',
    '{"provider":"nextcloud","subpath":"projects"}',
    '{"provider":"filebrowser"}',
    '{"provider":"filebrowser","subpath":"../projects"}',
  ]) {
    assert.throws(
      () => parseProjectSource(raw),
      /settings are invalid.*Stop Dev Workspace.*Configure Project Source/,
    )
  }
})

test('corrupt settings diagnostics do not reveal an app password', () => {
  const secret = 'secret-from-corrupt-settings'
  for (const raw of [secret, `{"appPassword":"${secret}", broken}`]) {
    assert.throws(
      () => parseProjectSource(raw),
      (error: Error) => {
        assert.match(error.message, /settings are invalid/)
        assert.equal(inspect(error).includes(secret), false)
        return true
      },
    )
  }
})

test('reads real missing, valid, and corrupt settings without changing their bytes', async () => {
  const files = await filesForTest()
  assert.deepEqual(await readProjectSource(undefined, files), {
    provider: 'none',
  })
  const source = { provider: 'filebrowser', subpath: 'Projects/One' }
  const raw = `${JSON.stringify(source)}\n`
  await replace(files.source.path, raw)
  assert.deepEqual(await readProjectSource(undefined, files), source)
  assert.equal(await fs.readFile(files.source.path, 'utf8'), raw)
  await replace(files.source.path, '{ invalid')
  await assert.rejects(
    readProjectSource(undefined, files),
    /settings are invalid/,
  )
  assert.equal(await fs.readFile(files.source.path, 'utf8'), '{ invalid')
  await replace(files.source.path, '')
  await assert.rejects(
    readProjectSource(undefined, files),
    /settings are invalid/,
  )
  assert.equal(await fs.readFile(files.source.path, 'utf8'), '')
})

test('reactive reads recover after corrupt JSON, invalid selections, and deletion', async (context) => {
  const files = await filesForTest()
  const first = { provider: 'filebrowser', subpath: 'Projects/First' }
  const second = { provider: 'filebrowser', subpath: 'Projects/Second' }
  await replace(files.source.path, JSON.stringify(first))
  const observed = await observe(files)
  context.after(() => observed.close())
  assert.deepEqual(observed.value, first)
  for (const corruption of ['', '{ invalid', '{"provider":"unknown"}']) {
    await replace(files.source.path, corruption)
    await eventually(() => observed.error instanceof Error)
    await replace(files.source.path, JSON.stringify(second))
    await eventually(() => observed.error === undefined)
    assert.deepEqual(observed.value, second)
  }
  await fs.unlink(files.source.path)
  await eventually(() => observed.value?.provider === 'none')
  assert.equal(observed.error, undefined)
  await replace(files.source.path, JSON.stringify(first))
  await eventually(() => observed.value?.provider === 'filebrowser')
  assert.deepEqual(observed.value, first)
})

test('rejects invalid saves while preserving previous configuration', async () => {
  const files = await filesForTest()
  const raw = '{"provider":"none"}\n'
  await replace(files.source.path, raw)
  await assert.rejects(
    saveProjectSource(
      effectsBoundary(),
      { provider: 'filebrowser', subpath: '../outside' },
      files,
    ),
    /nonempty relative folder/,
  )
  assert.equal(await fs.readFile(files.source.path, 'utf8'), raw)
})

test(
  'saves and reloads a selected folder with real SDK writes',
  linuxOnly,
  async () => {
    const files = await filesForTest()
    const source: ProjectSource = {
      provider: 'filebrowser',
      subpath: 'Proyectos compartidos/Aplicación',
    }
    assert.deepEqual(
      await saveProjectSource(effectsBoundary(), source, files),
      source,
    )
    assert.deepEqual(
      JSON.parse(await fs.readFile(files.source.path, 'utf8')),
      source,
    )
    assert.deepEqual(await readProjectSource(undefined, files), source)
  },
)

test(
  'disabling repairs corrupt settings without a provider',
  linuxOnly,
  async () => {
    const files = await filesForTest()
    await replace(files.source.path, '{ invalid')
    assert.deepEqual(
      await saveProjectSource(effectsBoundary(), { provider: 'none' }, files),
      { provider: 'none' },
    )
    assert.deepEqual(await readProjectSource(undefined, files), {
      provider: 'none',
    })
    assert.deepEqual(JSON.parse(await fs.readFile(files.source.path, 'utf8')), {
      provider: 'none',
    })
  },
)

test(
  'failed settings writes report failure and retain existing data',
  linuxOnly,
  async () => {
    const files = await filesForTest()
    await fs.mkdir(files.source.path)
    const retained = join(files.source.path, 'retained')
    await fs.writeFile(retained, 'existing project data')
    await assert.rejects(
      saveProjectSource(effectsBoundary(), { provider: 'none' }, files),
    )
    assert.equal(await fs.readFile(retained, 'utf8'), 'existing project data')
  },
)
