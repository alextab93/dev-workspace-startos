import assert from 'node:assert/strict'
import { test } from 'node:test'
import { packageStatusResult, statusValidator } from '../startos/packages'

const scan = {
  id: 'scan-1',
  operation: 'scan',
  state: 'succeeded',
  startedAt: '2026-11-15T14:30:40.000000-05:00',
  finishedAt: '2026-11-15T19:30:47.331232+00:00',
  message: 'Scan complete: 0 packages found.',
  package: null,
} as const

function render(job: unknown, history: unknown[] = []) {
  return packageStatusResult(statusValidator.parse({ job, history }))
}

test('installation status shows the latest result in a labelled multiline field without repeating it in history', () => {
  const result = render(scan, [scan])
  assert.equal(result.title, 'Installation Status')
  assert.equal(
    result.message,
    'Reopen Installation Status to refresh. Times are shown in UTC.',
  )
  assert.deepEqual(result.result, {
    type: 'group',
    value: [
      {
        type: 'multiline',
        name: 'Latest operation',
        description: 'Scan S9PK Packages: Completed',
        value: [
          'Scan complete: 0 packages found.',
          '',
          'Started: 2026-11-15 19:30:40 UTC',
          'Finished: 2026-11-15 19:30:47 UTC',
          'Operation ID: scan-1',
        ].join('\n'),
        masked: false,
        copyable: true,
        qr: false,
        filename: null,
      },
    ],
  })
})

test('previous operations are expandable, newest first, and leave the original history unchanged', () => {
  const older = { ...scan, id: 'older', operation: 'connect' }
  const newer = { ...scan, id: 'newer', operation: 'disconnect' }
  const status = statusValidator.parse({
    job: scan,
    history: [older, newer, scan],
  })
  const before = structuredClone(status)
  const history = packageStatusResult(status).result?.value[1]
  assert.equal(history?.type, 'group')
  assert.equal(history.name, 'Previous operations (2)')
  assert.deepEqual(
    history.value.map((item) => [item.name, item.description]),
    [
      ['Disconnect from StartOS: Completed', '2026-11-15 19:30:47 UTC'],
      ['Connect to StartOS: Completed', '2026-11-15 19:30:47 UTC'],
    ],
  )
  assert.deepEqual(status, before)
})

test('running, failed, interrupted and cancelled operations retain full messages and package details', () => {
  const message =
    'Package could not be installed. '.repeat(80) +
    '\nRestore source access and retry.'
  for (const [state, label] of [
    ['running', 'Running'],
    ['failed', 'Failed'],
    ['interrupted', 'Interrupted'],
    ['cancelled', 'Cancelled'],
  ]) {
    const item = render({
      ...scan,
      operation: 'install',
      state,
      finishedAt: null,
      message,
      package: {
        id: 'fixture',
        title: 'Fixture <one>',
        version: '1.0.0:0',
        sha256: 'a'.repeat(64),
      },
    }).result?.value[0]
    assert.equal(item?.type, 'multiline')
    assert.equal(item.description, `Install S9PK Package: ${label}`)
    assert.equal(
      item.value,
      [
        message,
        '',
        'Started: 2026-11-15 19:30:40 UTC',
        `Finished: ${state === 'running' ? 'In progress' : 'Not available'}`,
        'Package: Fixture <one> 1.0.0:0',
        'Package ID: fixture',
        `SHA256: ${'a'.repeat(64)}`,
        'Operation ID: scan-1',
      ].join('\n'),
    )
  }
})

test('empty status has a clear message and no empty report field', () => {
  assert.deepEqual(render(null), {
    version: '1',
    title: 'Installation Status',
    message: 'No package operations have run.',
    result: null,
  })
})

test('history remains available without a current job and displays at most the most recent 30 results', () => {
  const jobs = Array.from({ length: 35 }, (_, index) => ({
    ...scan,
    id: `scan-${index}`,
  }))
  const group = render(null, jobs).result?.value[0]
  assert.equal(group?.type, 'group')
  assert.equal(group.name, 'Previous operations (30)')
  assert.deepEqual(
    group.value.map((item) => item.value.split('\n').at(-1)),
    Array.from(
      { length: 30 },
      (_, index) => `Operation ID: scan-${34 - index}`,
    ),
  )
})

test('unrecognized operation names and legacy timestamp strings remain readable without inventing dates', () => {
  const item = render({
    ...scan,
    operation: 'repair',
    startedAt: 'unknown',
    finishedAt: 'legacy date',
  }).result?.value[0]
  assert.equal(item?.type, 'multiline')
  assert.equal(item.description, 'repair: Completed')
  assert.equal(
    item.value,
    'Scan complete: 0 packages found.\n\nStarted: unknown\nFinished: legacy date\nOperation ID: scan-1',
  )
})
