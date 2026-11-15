import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { connectionDetails } from '../startos/connectionDetails'

test('connection instructions use each endpoint and its assigned SSH port', () => {
  const endpoints = [
    { hostname: 'workspace.example.test', port: 41327 },
    { hostname: '2001:db8::7', port: 45222 },
    { hostname: 'default.example.test', port: null },
  ]
  const details = connectionDetails(endpoints, 'dev')
  const directory = mkdtempSync(join(tmpdir(), 'workspace-connections-'))
  try {
    const config = join(directory, 'config')
    writeFileSync(config, details.configuration)
    for (const [index, endpoint] of endpoints.entries()) {
      const output = execFileSync(
        'ssh',
        ['-G', '-F', config, `startos-dev-${index + 1}`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )
      const settings = Object.fromEntries(
        output
          .trim()
          .split('\n')
          .map((line) => {
            const separator = line.indexOf(' ')
            return [line.slice(0, separator), line.slice(separator + 1)]
          }),
      )
      assert.equal(settings.hostname, endpoint.hostname)
      assert.equal(settings.port, String(endpoint.port ?? 22))
      assert.equal(settings.user, 'dev')
      assert.equal(settings.identitiesonly, 'yes')
      assert.equal(settings.forwardagent, 'no')
    }
    assert.equal(
      details.commands,
      'ssh -p 41327 dev@workspace.example.test\nssh -p 45222 dev@2001:db8::7\nssh -p 22 dev@default.example.test',
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('missing endpoints do not produce a fictitious connection', () => {
  assert.deepEqual(connectionDetails([], 'dev'), {
    commands: '',
    configuration: '',
  })
})
