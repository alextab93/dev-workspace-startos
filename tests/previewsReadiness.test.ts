import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { previewRuntimeFile } from '../startos/fileModels/previews.json'
import { readPreviewRuntime } from '../startos/previews'

test('preview readiness accepts current waiting and listening reports and rejects stale or future observations', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1700000000000 })
  const directory = await fs.mkdtemp(join(tmpdir(), 'preview-readiness-'))
  const file = previewRuntimeFile.withPath(join(directory, 'runtime.json'))
  const report = {
    version: 1,
    revision: 1,
    observedAt: Date.now(),
    error: null,
    invalidRecords: 0,
    leases: [
      {
        id: randomUUID(),
        proxyPort: 18080,
        expiresAt: Date.now() + 60000,
        state: 'waiting',
      },
    ],
  }
  try {
    assert.equal(await readPreviewRuntime(file), null)
    await fs.writeFile(file.path, JSON.stringify(report))
    assert.deepEqual(await readPreviewRuntime(file), report)
    report.leases[0].state = 'listening'
    await fs.writeFile(file.path, JSON.stringify(report))
    assert.deepEqual(await readPreviewRuntime(file), report)
    report.observedAt = Date.now() - 14999
    await fs.writeFile(file.path, JSON.stringify(report))
    assert.deepEqual(await readPreviewRuntime(file), report)
    for (const observedAt of [
      Date.now() - 15000,
      Date.now() + 1,
      Date.now() + 60000,
    ]) {
      await fs.writeFile(file.path, JSON.stringify({ ...report, observedAt }))
      assert.equal(await readPreviewRuntime(file), null)
    }
    await fs.writeFile(file.path, '{invalid')
    assert.equal(await readPreviewRuntime(file), null)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
