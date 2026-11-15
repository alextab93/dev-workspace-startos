import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { ECDH } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { parsePublicKey } from '../startos/sshKeys'

const directory = mkdtempSync(join(tmpdir(), 'dev-workspace-public-keys-'))
after(() => rmSync(directory, { recursive: true, force: true }))

function generate(name: string, algorithm: string, bits?: number) {
  const path = join(directory, name)
  const args = ['-q', '-t', algorithm, '-N', '', '-C', name, '-f', path]
  if (bits) args.push('-b', String(bits))
  execFileSync('ssh-keygen', args)
  const key = readFileSync(`${path}.pub`, 'utf8').trim()
  const fingerprint = execFileSync(
    'ssh-keygen',
    ['-lf', `${path}.pub`, '-E', 'sha256'],
    { encoding: 'utf8' },
  )
    .trim()
    .split(/\s+/)[1]
  return { key, fingerprint, path }
}

const ed25519 = generate('ed25519', 'ed25519')
const rsa = generate('rsa', 'rsa', 2048)
const weakRsa = generate('weak-rsa', 'rsa', 1024)
const ecdsa = [256, 384, 521].map((bits) =>
  generate(`ecdsa-${bits}`, 'ecdsa', bits),
)

function fields(key: string) {
  const blob = Buffer.from(key.split(/\s+/)[1], 'base64')
  const result: Buffer[] = []
  for (let cursor = 0; cursor < blob.length; ) {
    const length = blob.readUInt32BE(cursor)
    cursor += 4
    result.push(blob.subarray(cursor, cursor + length))
    cursor += length
  }
  return result
}

function encodedKey(type: string, values: Buffer[], suffix = Buffer.alloc(0)) {
  const encoded = values.map((value) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(value.length)
    return Buffer.concat([length, value])
  })
  return `${type} ${Buffer.concat([...encoded, suffix]).toString('base64')}`
}

for (const fixture of [ed25519, rsa, ...ecdsa]) {
  const [type, encoded] = fixture.key.split(/\s+/)
  test(`accepts a real ${type} key with its OpenSSH fingerprint`, () => {
    assert.deepEqual(parsePublicKey(fixture.key), {
      publicKey: `${type} ${encoded}`,
      fingerprint: fixture.fingerprint,
      type,
    })
  })
}

test('accepts surrounding whitespace and discards a human key label', () => {
  const [type, encoded] = ed25519.key.split(/\s+/)
  const parsed = parsePublicKey(` \t${type}\t${encoded} developer laptop\r\n`)
  assert.equal(parsed.publicKey, `${type} ${encoded}`)
  assert.equal(parsed.fingerprint, ed25519.fingerprint)
})

test('treats shell syntax in a human label as discarded text', () => {
  const [type, encoded] = ed25519.key.split(/\s+/)
  assert.equal(
    parsePublicKey(`${type} ${encoded} $(touch forbidden) ; \`id\``).publicKey,
    `${type} ${encoded}`,
  )
})

test('accepts a harmless label mentioning a private key', () => {
  const [type, encoded] = ed25519.key.split(/\s+/)
  assert.equal(
    parsePublicKey(`${type} ${encoded} PRIVATE KEY remains on my laptop`)
      .publicKey,
    `${type} ${encoded}`,
  )
})

test('canonicalizes valid unpadded base64 without changing identity', () => {
  const [type, encoded] = ecdsa[0].key.split(/\s+/)
  assert.deepEqual(
    parsePublicKey(`${type} ${encoded.replace(/=+$/, '')}`),
    parsePublicKey(`${type} ${encoded}`),
  )
})

test('rejects a private key', () => {
  assert.throws(
    () => parsePublicKey(readFileSync(ed25519.path, 'utf8')),
    /Provide the public key, never a private key/,
  )
})

for (const prefix of [
  'command="id"',
  'restrict',
  'cert-authority',
  'from="*"',
]) {
  test(`rejects authorized_keys option ${prefix}`, () => {
    assert.throws(
      () => parsePublicKey(`${prefix} ${ed25519.key}`),
      /Invalid SSH public key/,
    )
  })
}

test('rejects multiple key records or embedded line breaks', () => {
  for (const input of [
    `${ed25519.key}\n${rsa.key}`,
    `${ed25519.key}\r${rsa.key}`,
    `${ed25519.key}\nextra text`,
    `${ed25519.key}\0extra text`,
  ]) {
    assert.throws(() => parsePublicKey(input), /exactly one public key/)
  }
})

test('rejects unsupported key types', () => {
  for (const type of [
    'ssh-dss',
    'ssh-ed25519-cert-v01@openssh.com',
    'invalid',
  ]) {
    assert.throws(
      () => parsePublicKey(`${type} ${ed25519.key.split(/\s+/)[1]}`),
      /Invalid SSH public key/,
    )
  }
})

test('rejects malformed base64 including noncanonical padding bits', () => {
  const encoded = ecdsa[0].key.split(/\s+/)[1]
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const lastData = encoded.search(/=/) - 1
  const alternate =
    encoded.slice(0, lastData) +
    alphabet[alphabet.indexOf(encoded[lastData]) + 1] +
    encoded.slice(lastData + 1)
  for (const value of [
    '?',
    'A',
    'AAAA===',
    `${encoded}=`,
    `${encoded}!`,
    alternate,
  ]) {
    assert.throws(
      () => parsePublicKey(`ecdsa-sha2-nistp256 ${value}`),
      /Invalid SSH public key/,
    )
  }
})

test('rejects a key whose outer and wire algorithm disagree', () => {
  assert.throws(
    () => parsePublicKey(`ssh-ed25519 ${rsa.key.split(/\s+/)[1]}`),
    /key type does not match/,
  )
})

test('rejects truncated lengths and incomplete fields', () => {
  const blob = Buffer.from(ed25519.key.split(/\s+/)[1], 'base64')
  const oversized = Buffer.from(blob)
  oversized.writeUInt32BE(0xffffffff, 0)
  for (const value of [blob.subarray(0, 2), blob.subarray(0, -1), oversized]) {
    assert.throws(
      () => parsePublicKey(`ssh-ed25519 ${value.toString('base64')}`),
      /key is truncated/,
    )
  }
})

test('rejects trailing binary fields', () => {
  for (const fixture of [ed25519, rsa, ...ecdsa]) {
    const type = fixture.key.split(/\s+/)[0]
    assert.throws(
      () =>
        parsePublicKey(encodedKey(type, fields(fixture.key), Buffer.from([0]))),
      /Unexpected data follows/,
    )
  }
})

test('rejects Ed25519 payloads with the wrong size', () => {
  const [type, key] = fields(ed25519.key)
  for (const value of [
    key.subarray(0, 31),
    Buffer.concat([key, Buffer.from([0])]),
  ]) {
    assert.throws(
      () => parsePublicKey(encodedKey('ssh-ed25519', [type, value])),
      /Ed25519 keys must contain 32 bytes/,
    )
  }
})

test('rejects RSA keys smaller than 2048 bits', () => {
  assert.throws(() => parsePublicKey(weakRsa.key), /at least 2048 bits/)
})

test('rejects invalid RSA exponents', () => {
  const [type, , modulus] = fields(rsa.key)
  for (const exponent of [
    Buffer.alloc(0),
    Buffer.from([0]),
    Buffer.from([1]),
    Buffer.from([2]),
    Buffer.from([0x80]),
    modulus,
  ]) {
    assert.throws(
      () => parsePublicKey(encodedKey('ssh-rsa', [type, exponent, modulus])),
      /Invalid SSH public key/,
    )
  }
})

test('rejects RSA modulus encodings that are negative, redundant, or even', () => {
  const [type, exponent, modulus] = fields(rsa.key)
  const even = Buffer.from(modulus)
  even[even.length - 1] &= 0xfe
  for (const value of [
    modulus.subarray(1),
    Buffer.concat([Buffer.from([0]), modulus]),
    even,
  ]) {
    assert.throws(
      () => parsePublicKey(encodedKey('ssh-rsa', [type, exponent, value])),
      /Invalid SSH public key/,
    )
  }
})

test('rejects a noncanonical positive RSA exponent', () => {
  const [type, exponent, modulus] = fields(rsa.key)
  assert.throws(
    () =>
      parsePublicKey(
        encodedKey('ssh-rsa', [
          type,
          Buffer.concat([Buffer.from([0]), exponent]),
          modulus,
        ]),
      ),
    /canonical encoding/,
  )
})

test('rejects ECDSA curve-name mismatches', () => {
  const [type, , point] = fields(ecdsa[0].key)
  assert.throws(
    () =>
      parsePublicKey(
        encodedKey('ecdsa-sha2-nistp256', [
          type,
          Buffer.from('nistp384'),
          point,
        ]),
      ),
    /curve does not match/,
  )
})

test('rejects ECDSA points that are not on the declared curve', () => {
  for (const fixture of ecdsa) {
    const [type, curve, point] = fields(fixture.key)
    const invalidPoint = Buffer.alloc(point.length)
    invalidPoint[0] = 4
    assert.throws(
      () =>
        parsePublicKey(
          encodedKey(type.toString(), [type, curve, invalidPoint]),
        ),
      /point is not valid/,
    )
  }
})

test('rejects compressed ECDSA points unsupported by OpenSSH public key files', () => {
  const [type, curve, point] = fields(ecdsa[0].key)
  const compressed = Buffer.from(
    ECDH.convertKey(
      point,
      'prime256v1',
      undefined,
      'hex',
      'compressed',
    ).toString(),
    'hex',
  )
  assert.throws(
    () =>
      parsePublicKey(encodedKey(type.toString(), [type, curve, compressed])),
    /uncompressed curve point/,
  )
})

test('rejects excessive input', () => {
  assert.throws(
    () => parsePublicKey(`${ed25519.key} ${'x'.repeat(32768)}`),
    /too long/,
  )
})

test('canonical accepted keys retain their fingerprint when read by OpenSSH', () => {
  for (const fixture of [ed25519, rsa, ...ecdsa]) {
    const parsed = parsePublicKey(fixture.key)
    const path = join(directory, 'canonical.pub')
    writeFileSync(path, `${parsed.publicKey}\n`)
    const actual = execFileSync('ssh-keygen', ['-lf', path, '-E', 'sha256'], {
      encoding: 'utf8',
    })
      .trim()
      .split(/\s+/)[1]
    assert.equal(actual, parsed.fingerprint)
  }
})
