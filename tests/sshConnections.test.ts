import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sshConnectionHealth } from '../startos/sshConnections'

test('reports the authenticated SSH count and treats zero as healthy', () => {
  for (const count of [0, 1, 2, 100]) {
    assert.deepEqual(
      sshConnectionHealth(JSON.stringify({ connections: count })),
      { result: 'success', message: `SSH connections: ${count}` },
    )
  }
})

test('unavailable or invalid counts never become a healthy zero or expose diagnostics', () => {
  for (const output of [
    undefined,
    '',
    'private-runtime-diagnostic',
    'null',
    '0',
    '[]',
    '{}',
    '{"connections":null}',
    '{"connections":true}',
    '{"connections":"2"}',
    '{"connections":-1}',
    '{"connections":0.5}',
    '{"connections":9007199254740992}',
  ]) {
    assert.deepEqual(sshConnectionHealth(output), {
      result: 'failure',
      message: 'SSH connection count is unavailable.',
    })
  }
})
