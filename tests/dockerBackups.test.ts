import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { syncStorage } from '../startos/backups'

const linuxRsync =
  process.platform === 'linux' && spawnSync('rsync', ['--version']).status === 0

test(
  'Docker storage backup and restore preserve files, ownership, modes, links, and FIFO metadata',
  { skip: !linuxRsync },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-backup-'))
    t.after(() => fs.rm(directory, { recursive: true, force: true }))
    const source = path.join(directory, 'source')
    const backup = path.join(directory, 'backup')
    const restored = path.join(directory, 'restored')
    await fs.mkdir(path.join(source, 'volumes', 'database', '_data'), {
      recursive: true,
    })
    await fs.mkdir(path.join(source, 'containers', 'stopped'), {
      recursive: true,
    })
    const data = path.join(source, 'volumes', 'database', '_data', 'records')
    await fs.writeFile(data, 'database-persistence-fixture\n', { mode: 0o640 })
    await fs.chmod(data, 0o640)
    if (process.getuid?.() === 0) await fs.chown(data, 1000, 1000)
    await fs.writeFile(
      path.join(source, 'containers', 'stopped', 'config.v2.json'),
      '{"fixture":"retained"}\n',
    )
    await fs.link(data, path.join(source, 'hardlink'))
    await fs.symlink(
      'volumes/database/_data/records',
      path.join(source, 'symbolic'),
    )
    assert.equal(spawnSync('mkfifo', [path.join(source, 'fifo')]).status, 0)
    const original = await fs.stat(data)

    await syncStorage(source, backup)
    await fs.mkdir(restored)
    await fs.writeFile(
      path.join(restored, 'stale'),
      'removed only after the source is validated',
    )
    await syncStorage(backup, restored)

    const restoredData = path.join(
      restored,
      'volumes',
      'database',
      '_data',
      'records',
    )
    const metadata = await fs.stat(restoredData)
    assert.equal(
      await fs.readFile(restoredData, 'utf8'),
      'database-persistence-fixture\n',
    )
    assert.equal(
      await fs.readFile(
        path.join(restored, 'containers', 'stopped', 'config.v2.json'),
        'utf8',
      ),
      '{"fixture":"retained"}\n',
    )
    assert.equal(metadata.mode & 0o7777, 0o640)
    assert.equal(metadata.uid, original.uid)
    assert.equal(metadata.gid, original.gid)
    if (process.getuid?.() === 0) {
      assert.equal(metadata.uid, 1000)
      assert.equal(metadata.gid, 1000)
    }
    assert.equal(
      (await fs.stat(path.join(restored, 'hardlink'))).ino,
      metadata.ino,
    )
    assert.equal(
      await fs.readlink(path.join(restored, 'symbolic')),
      'volumes/database/_data/records',
    )
    assert.equal((await fs.lstat(path.join(restored, 'fifo'))).isFIFO(), true)
    await assert.rejects(fs.lstat(path.join(restored, 'stale')), {
      code: 'ENOENT',
    })
  },
)

test(
  'Docker backup preserves whiteout devices across restore',
  { skip: !linuxRsync },
  async (t) => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'docker-whiteout-'),
    )
    t.after(() => fs.rm(directory, { recursive: true, force: true }))
    const source = path.join(directory, 'source')
    const backup = path.join(directory, 'backup')
    const restored = path.join(directory, 'restored')
    await fs.mkdir(source)
    const whiteout = path.join(source, 'deleted-file')
    const node = spawnSync('mknod', [whiteout, 'c', '0', '0'], {
      encoding: 'utf8',
    })
    if (node.status !== 0) {
      t.skip('This environment cannot create a character-device whiteout')
      return
    }
    await syncStorage(source, backup)
    await syncStorage(backup, restored)
    const result = await fs.lstat(path.join(restored, 'deleted-file'))
    assert.equal(result.isCharacterDevice(), true)
    assert.equal(result.rdev, 0)
  },
)

test(
  'Docker backup preserves extended attributes across restore',
  { skip: !linuxRsync },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-xattr-'))
    t.after(() => fs.rm(directory, { recursive: true, force: true }))
    const source = path.join(directory, 'source')
    const backup = path.join(directory, 'backup')
    const restored = path.join(directory, 'restored')
    await fs.mkdir(source)
    const regular = path.join(source, 'opaque-directory-marker')
    await fs.writeFile(regular, 'attribute fixture')
    const attributes = spawnSync(
      'python3',
      [
        '-c',
        'import os,sys; os.setxattr(sys.argv[1], "user.backup-fixture", b"preserved")',
        regular,
      ],
      { encoding: 'utf8' },
    )
    assert.equal(attributes.status, 0, attributes.stderr)
    await syncStorage(source, backup)
    await syncStorage(backup, restored)
    const restoredAttributes = spawnSync(
      'python3',
      [
        '-c',
        'import os,sys; sys.stdout.buffer.write(os.getxattr(sys.argv[1], "user.backup-fixture"))',
        path.join(restored, 'opaque-directory-marker'),
      ],
      { encoding: 'utf8' },
    )
    assert.equal(restoredAttributes.status, 0, restoredAttributes.stderr)
    assert.equal(restoredAttributes.stdout, 'preserved')
  },
)

test(
  'Docker backup rejects missing and symlink sources before deleting destination data',
  { skip: !linuxRsync },
  async (t) => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'docker-backup-validation-'),
    )
    t.after(() => fs.rm(directory, { recursive: true, force: true }))
    const destination = path.join(directory, 'destination')
    await fs.mkdir(destination)
    await fs.writeFile(path.join(destination, 'keep'), 'existing-backup')
    await assert.rejects(
      syncStorage(path.join(directory, 'missing'), destination),
      /source is missing/,
    )
    assert.equal(
      await fs.readFile(path.join(destination, 'keep'), 'utf8'),
      'existing-backup',
    )
    const source = path.join(directory, 'source')
    await fs.symlink(destination, source)
    await assert.rejects(syncStorage(source, destination), /source is missing/)
    assert.equal(
      await fs.readFile(path.join(destination, 'keep'), 'utf8'),
      'existing-backup',
    )
    await assert.rejects(
      syncStorage(destination, destination),
      /separate directories/,
    )
    assert.equal(
      await fs.readFile(path.join(destination, 'keep'), 'utf8'),
      'existing-backup',
    )
  },
)

test(
  'Docker backup rejects a symlink destination without changing its target',
  { skip: !linuxRsync },
  async (t) => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'docker-backup-target-'),
    )
    t.after(() => fs.rm(directory, { recursive: true, force: true }))
    const source = path.join(directory, 'source')
    const destination = path.join(directory, 'destination')
    const outside = path.join(directory, 'outside')
    await fs.mkdir(source)
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'keep'), 'outside-data')
    await fs.symlink(outside, destination)
    await assert.rejects(
      syncStorage(source, destination),
      /destination is not a directory/,
    )
    assert.equal(
      await fs.readFile(path.join(outside, 'keep'), 'utf8'),
      'outside-data',
    )
  },
)

test(
  'a repeated Docker backup restores changed bytes with the same length and modification time',
  { skip: !linuxRsync },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-repeat-'))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    const source = path.join(root, 'source')
    const backup = path.join(root, 'backup')
    const restored = path.join(root, 'restored')
    await fs.mkdir(source)
    const record = path.join(source, 'record')
    const timestamp = new Date('2020-01-01T12:00:00Z')
    for (const revision of ['first', 'later']) {
      await fs.writeFile(record, revision)
      await fs.utimes(record, timestamp, timestamp)
      await syncStorage(source, backup)
    }
    await syncStorage(backup, restored)
    assert.equal(
      await fs.readFile(path.join(restored, 'record'), 'utf8'),
      'later',
    )
  },
)

test(
  'a repeated backup restores formerly linked files as independent files',
  { skip: !linuxRsync },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-links-'))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    const source = path.join(root, 'source')
    const backup = path.join(root, 'backup')
    const restored = path.join(root, 'restored')
    await fs.mkdir(source)
    await fs.writeFile(path.join(source, 'original'), 'first')
    for (const name of ['changed', 'identical']) {
      await fs.link(path.join(source, 'original'), path.join(source, name))
    }
    await syncStorage(source, backup)
    for (const [name, value] of [
      ['changed', 'later'],
      ['identical', 'first'],
    ]) {
      const file = path.join(source, name)
      await fs.unlink(file)
      await fs.writeFile(file, value)
    }
    await syncStorage(source, backup)
    await syncStorage(backup, restored)
    assert.equal(
      await fs.readFile(path.join(restored, 'changed'), 'utf8'),
      'later',
    )
    assert.equal(
      await fs.readFile(path.join(restored, 'identical'), 'utf8'),
      'first',
    )
    await fs.writeFile(path.join(restored, 'identical'), 'independent edit')
    assert.equal(
      await fs.readFile(path.join(restored, 'original'), 'utf8'),
      'first',
    )
  },
)
