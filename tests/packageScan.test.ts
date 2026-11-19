import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const scanner = resolve('assets/workspace-package-files.py')

async function scan(
  roots: string[],
  limits: { entries?: number; files?: number } = {},
) {
  const result = await execute(
    'python3',
    [
      '-B',
      '-c',
      `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('package_files',sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.ROOTS=tuple(json.loads(sys.argv[2]))
limits=json.loads(sys.argv[3])
module.MAX_ENTRIES=limits.get('entries',module.MAX_ENTRIES)
module.MAX_FILES=limits.get('files',module.MAX_FILES)
print(json.dumps(module.scan()))`,
      scanner,
      JSON.stringify(roots),
      JSON.stringify(limits),
    ],
    { timeout: 15_000 },
  )
  return JSON.parse(result.stdout) as {
    packages: unknown[]
    errors: { path: string; error: string }[]
    truncated: boolean
    statistics: {
      durationSeconds: number
      limitsReached: string[]
      roots: {
        path: string
        status: string
        durationSeconds: number
        entriesVisited: number
        directoriesSkipped: number
        symlinksSkipped: number
        otherEntriesSkipped: number
        candidates: number
        packagesFound: number
        errors: number
        hashedBytes: number
        hashingSeconds: number
        inspectionSeconds: number
      }[]
    }
  }
}

function nested(root: string, depth: number) {
  return join(
    root,
    ...Array.from({ length: depth }, (_, i) => `level-${i + 1}`),
  )
}

test('package scan visits depth 40 relative to each project root', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workspace-scan-'))
  try {
    const root = join(directory, 'project-root')
    const atLimit = nested(root, 40)
    await mkdir(atLimit, { recursive: true })
    const archive = join(atLimit, 'empty.s9pk')
    await writeFile(archive, '')
    const { statistics, ...catalog } = await scan([root])
    assert.deepEqual(catalog, {
      packages: [],
      errors: [
        {
          path: archive,
          error:
            'The package must be a regular file between 1 byte and 32 GiB.',
        },
      ],
      truncated: false,
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('package scan reports omitted subtrees and continues other folders and roots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workspace-scan-'))
  try {
    const root = join(directory, 'first-root')
    const otherRoot = join(directory, 'second-root')
    const omitted = nested(root, 41)
    await mkdir(omitted, { recursive: true })
    await mkdir(otherRoot)
    await writeFile(join(omitted, 'unvisited.s9pk'), '')
    const sameRootArchive = join(root, 'empty.s9pk')
    const otherRootArchive = join(otherRoot, 'empty.s9pk')
    await writeFile(sameRootArchive, '')
    await writeFile(otherRootArchive, '')
    const result = await scan([root, otherRoot])
    assert.equal(result.truncated, true)
    assert.deepEqual(result.packages, [])
    assert.deepEqual(
      result.errors.map((entry) => entry.path).sort(),
      [omitted, sameRootArchive, otherRootArchive].sort(),
    )
    assert.equal(
      result.errors.find((entry) => entry.path === omitted)?.error,
      'Directory depth limit reached; subtree was not scanned.',
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('intentional dependency and symlink exclusions do not claim an incomplete scan', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workspace-scan-'))
  try {
    const root = join(directory, 'project-root')
    await mkdir(root)
    for (const name of ['.git', 'node_modules', '.venv', 'venv']) {
      const excluded = nested(join(root, name), 41)
      await mkdir(excluded, { recursive: true })
      await writeFile(join(excluded, 'excluded.s9pk'), '')
    }
    const outside = join(directory, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'excluded.s9pk'), '')
    await symlink(outside, join(root, 'linked-directory'))
    await symlink(join(outside, 'excluded.s9pk'), join(root, 'linked.s9pk'))
    const { statistics, ...catalog } = await scan([root])
    assert.deepEqual(catalog, {
      packages: [],
      errors: [],
      truncated: false,
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('scan statistics describe real per-root traversal, exclusions and hashing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workspace-scan-'))
  try {
    const local = join(directory, 'local')
    const shared = join(directory, 'shared')
    await mkdir(join(local, 'project'), { recursive: true })
    await mkdir(shared)
    for (const name of ['.git', 'node_modules', '.venv', 'venv']) {
      await mkdir(join(local, name))
      await writeFile(join(local, name, 'excluded.s9pk'), 'excluded')
    }
    await writeFile(join(local, 'notes.txt'), 'notes')
    await writeFile(join(local, 'project', 'README.md'), 'project')
    const bytes = Buffer.from('a malformed archive with known bytes')
    await writeFile(join(local, 'project', 'broken.s9pk'), bytes)
    await symlink(shared, join(local, 'linked-directory'))
    await symlink(
      join(local, 'project', 'broken.s9pk'),
      join(local, 'linked.s9pk'),
    )
    const result = await scan([local, shared])
    assert.equal(result.truncated, false)
    assert.deepEqual(result.packages, [])
    assert.equal(result.errors.length, 1)
    const [first, second] = result.statistics.roots
    assert.deepEqual(
      {
        path: first.path,
        status: first.status,
        entries: first.entriesVisited,
        directories: first.directoriesSkipped,
        symlinks: first.symlinksSkipped,
        other: first.otherEntriesSkipped,
        candidates: first.candidates,
        packages: first.packagesFound,
        errors: first.errors,
        bytes: first.hashedBytes,
      },
      {
        path: local,
        status: 'complete',
        entries: 10,
        directories: 4,
        symlinks: 2,
        other: 2,
        candidates: 1,
        packages: 0,
        errors: 1,
        bytes: bytes.length,
      },
    )
    assert.equal(second.path, shared)
    assert.equal(second.status, 'complete')
    assert.equal(second.entriesVisited, 0)
    assert.equal(second.hashedBytes, 0)
    assert.equal(second.hashingSeconds, 0)
    assert.equal(second.inspectionSeconds, 0)
    assert.ok(first.hashingSeconds > 0)
    assert.ok(first.inspectionSeconds > 0)
    assert.ok(
      first.durationSeconds >= first.hashingSeconds + first.inspectionSeconds,
    )
    assert.ok(
      result.statistics.durationSeconds >=
        first.durationSeconds + second.durationSeconds,
    )
    assert.deepEqual(result.statistics.limitsReached, [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('error totals include failures beyond the bounded displayed error list', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workspace-scan-'))
  try {
    await Promise.all(
      Array.from({ length: 105 }, (_, index) =>
        writeFile(join(directory, `${index}.s9pk`), ''),
      ),
    )
    const result = await scan([directory])
    assert.equal(result.truncated, false)
    assert.equal(result.errors.length, 100)
    assert.equal(result.statistics.roots[0].entriesVisited, 105)
    assert.equal(result.statistics.roots[0].candidates, 105)
    assert.equal(result.statistics.roots[0].errors, 105)
    assert.equal(result.statistics.roots[0].hashedBytes, 0)
    assert.deepEqual(result.packages, [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('entry exhaustion identifies roots that were not scanned', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workspace-scan-'))
  try {
    const first = join(directory, 'first')
    const second = join(directory, 'second')
    await mkdir(first)
    await mkdir(second)
    for (const name of ['one.txt', 'two.txt', 'three.txt'])
      await writeFile(join(first, name), '')
    const result = await scan([first, second], { entries: 2 })
    assert.equal(result.truncated, true)
    assert.deepEqual(result.statistics.limitsReached, ['entries'])
    assert.deepEqual(
      result.statistics.roots.map(({ status, entriesVisited }) => ({
        status,
        entriesVisited,
      })),
      [
        { status: 'incomplete', entriesVisited: 2 },
        { status: 'not-scanned', entriesVisited: 0 },
      ],
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a fully visited tree at the entry budget stays complete', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workspace-scan-'))
  try {
    await writeFile(join(directory, 'one.txt'), '')
    await writeFile(join(directory, 'two.txt'), '')
    const result = await scan([directory], { entries: 2 })
    assert.equal(result.truncated, false)
    assert.deepEqual(result.statistics.limitsReached, [])
    assert.equal(result.statistics.roots[0].entriesVisited, 2)
    assert.equal(result.statistics.roots[0].status, 'complete')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('candidate exhaustion reports the package limit and inspected count', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workspace-scan-'))
  try {
    await writeFile(join(directory, 'one.s9pk'), '')
    await writeFile(join(directory, 'two.s9pk'), '')
    const result = await scan([directory], { files: 1 })
    assert.equal(result.truncated, true)
    assert.deepEqual(result.statistics.limitsReached, ['packages'])
    assert.equal(result.statistics.roots[0].candidates, 1)
    assert.equal(result.statistics.roots[0].errors, 1)
    assert.equal(result.statistics.roots[0].status, 'incomplete')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('missing and symlinked project roots are reported without following them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workspace-scan-'))
  try {
    const missing = join(directory, 'missing')
    const existing = join(directory, 'existing')
    const linked = join(directory, 'linked')
    await mkdir(existing)
    await writeFile(join(existing, 'unvisited.s9pk'), '')
    await symlink(existing, linked)
    const result = await scan([missing, linked])
    assert.equal(result.truncated, true)
    assert.deepEqual(result.packages, [])
    assert.equal(result.errors.length, 2)
    assert.deepEqual(
      result.statistics.roots.map(({ status, entriesVisited, errors }) => ({
        status,
        entriesVisited,
        errors,
      })),
      [
        { status: 'unavailable', entriesVisited: 0, errors: 1 },
        { status: 'unavailable', entriesVisited: 0, errors: 1 },
      ],
    )
    assert.deepEqual(result.statistics.limitsReached, [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test(
  'unreadable directories mark the scan incomplete',
  { skip: process.getuid?.() === 0 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workspace-scan-'))
    const denied = join(directory, 'denied')
    try {
      await mkdir(denied)
      await writeFile(join(denied, 'unvisited.s9pk'), '')
      await chmod(denied, 0)
      const result = await scan([directory])
      assert.equal(result.truncated, true)
      assert.deepEqual(result.errors, [
        { path: denied, error: 'Directory could not be read.' },
      ])
      assert.equal(result.statistics.roots[0].status, 'incomplete')
      assert.equal(result.statistics.roots[0].errors, 1)
    } finally {
      await chmod(denied, 0o700)
      await rm(directory, { recursive: true, force: true })
    }
  },
)
