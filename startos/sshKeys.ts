import { createHash, createPublicKey, ECDH } from 'node:crypto'

export type ParsedPublicKey = {
  publicKey: string
  fingerprint: string
  type: string
}

const curves = {
  'ecdsa-sha2-nistp256': {
    name: 'nistp256',
    openssl: 'prime256v1',
    jwk: 'P-256',
    size: 32,
  },
  'ecdsa-sha2-nistp384': {
    name: 'nistp384',
    openssl: 'secp384r1',
    jwk: 'P-384',
    size: 48,
  },
  'ecdsa-sha2-nistp521': {
    name: 'nistp521',
    openssl: 'secp521r1',
    jwk: 'P-521',
    size: 66,
  },
} as const

const invalid = (reason: string) =>
  new Error(`Invalid SSH public key: ${reason}`)

function positiveInteger(value: Buffer): Buffer {
  if (!value.length || value[0] & 0x80) {
    throw invalid('RSA integers must be positive.')
  }
  if (value[0] === 0) {
    if (value.length === 1 || !(value[1] & 0x80)) {
      throw invalid('RSA integers must use their canonical encoding.')
    }
    return value.subarray(1)
  }
  return value
}

export function parsePublicKey(input: string): ParsedPublicKey {
  if (input.length > 32768) throw invalid('The key is too long.')
  const line = input.trim()
  if (/^-----BEGIN [^\r\n]*PRIVATE KEY-----/.test(line)) {
    throw invalid('Provide the public key, never a private key.')
  }
  if (/[\r\n\0]/.test(line)) {
    throw invalid('Provide exactly one public key on one line.')
  }
  const match = line.match(
    /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521))[\t ]+([A-Za-z0-9+/]+={0,2})(?:[\t ]+[^\r\n\0]*)?$/,
  )
  if (!match) {
    throw invalid(
      'Use an Ed25519, RSA, or NIST ECDSA public key without authorized_keys options.',
    )
  }
  const [, type, encoded] = match
  const blob = Buffer.from(encoded, 'base64')
  const canonical = blob.toString('base64')
  if (encoded !== canonical && encoded !== canonical.replace(/=+$/, '')) {
    throw invalid('The key contains malformed base64.')
  }
  let offset = 0
  const read = () => {
    if (offset + 4 > blob.length) throw invalid('The key is truncated.')
    const size = blob.readUInt32BE(offset)
    offset += 4
    if (size > blob.length - offset) throw invalid('The key is truncated.')
    const value = blob.subarray(offset, offset + size)
    offset += size
    return value
  }
  if (!read().equals(Buffer.from(type))) {
    throw invalid('The key type does not match its encoded data.')
  }

  if (type === 'ssh-ed25519') {
    const key = read()
    if (key.length !== 32) throw invalid('Ed25519 keys must contain 32 bytes.')
    createPublicKey({
      format: 'jwk',
      key: { kty: 'OKP', crv: 'Ed25519', x: key.toString('base64url') },
    })
  } else if (type === 'ssh-rsa') {
    const exponent = positiveInteger(read())
    const modulus = positiveInteger(read())
    const bits = modulus.length * 8 - (Math.clz32(modulus[0]) - 24)
    if (bits < 2048) throw invalid('RSA keys must be at least 2048 bits.')
    const e = BigInt(`0x${exponent.toString('hex')}`)
    const n = BigInt(`0x${modulus.toString('hex')}`)
    if (e < 3n || e >= n || e % 2n === 0n || n % 2n === 0n) {
      throw invalid('The RSA public parameters are invalid.')
    }
    try {
      createPublicKey({
        format: 'jwk',
        key: {
          kty: 'RSA',
          e: exponent.toString('base64url'),
          n: modulus.toString('base64url'),
        },
      })
    } catch {
      throw invalid('The RSA public parameters are invalid.')
    }
  } else {
    const curve = curves[type as keyof typeof curves]
    if (!read().equals(Buffer.from(curve.name))) {
      throw invalid('The ECDSA curve does not match the key type.')
    }
    const point = read()
    if (point.length !== 1 + 2 * curve.size || point[0] !== 4) {
      throw invalid('The ECDSA key must contain an uncompressed curve point.')
    }
    try {
      ECDH.convertKey(
        point,
        curve.openssl,
        undefined,
        undefined,
        'uncompressed',
      )
      createPublicKey({
        format: 'jwk',
        key: {
          kty: 'EC',
          crv: curve.jwk,
          x: point.subarray(1, 1 + curve.size).toString('base64url'),
          y: point.subarray(1 + curve.size).toString('base64url'),
        },
      })
    } catch {
      throw invalid('The ECDSA point is not valid for its curve.')
    }
  }
  if (offset !== blob.length) throw invalid('Unexpected data follows the key.')
  const digest = createHash('sha256').update(blob).digest('base64')
  return {
    publicKey: `${type} ${canonical}`,
    fingerprint: `SHA256:${digest.replace(/=+$/, '')}`,
    type,
  }
}
