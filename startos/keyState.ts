import type { types } from '@start9labs/start-sdk'
import { randomUUID } from 'node:crypto'
import {
  keyFiles,
  storeSchema,
  type KeyFiles,
  type KeyStore,
  type SshKey,
} from './fileModels/store.json'
import { parsePublicKey } from './sshKeys'

export function newKeyStore(): KeyStore {
  return { keys: [], generation: randomUUID(), revision: 0 }
}

export function parseKeyStore(raw: string | null): KeyStore {
  if (raw === null) {
    throw new Error(
      'Workspace configuration is missing. Restore the service configuration or restart service initialization before managing SSH keys.',
    )
  }
  try {
    const state = storeSchema.parse(JSON.parse(raw))
    const fingerprints = new Set<string>()
    for (const key of state.keys) {
      const parsed = parsePublicKey(key.publicKey)
      validateLabel(key.label)
      if (
        key.fingerprint !== parsed.fingerprint ||
        key.type !== parsed.type ||
        fingerprints.has(parsed.fingerprint)
      ) {
        throw new Error('SSH key identity metadata is inconsistent.')
      }
      fingerprints.add(parsed.fingerprint)
    }
    return state
  } catch (cause) {
    throw new Error(
      'Workspace configuration is invalid. Repair or restore store.json before managing SSH keys. Project files have not been changed.',
      { cause },
    )
  }
}

export async function readKeyStore(
  effects: types.Effects,
  files: KeyFiles = keyFiles,
): Promise<KeyStore> {
  return parseKeyStore(await files.source.read().const(effects))
}

export async function synchronizeKeys(
  effects: types.Effects,
  files: KeyFiles = keyFiles,
) {
  let state: KeyStore
  try {
    state = await readKeyStore(effects, files)
  } catch (error) {
    await files.authorized.write(effects, '')
    throw error
  }
  await files.authorized.write(effects, renderKeys(state.keys))
  await files.applied.write(effects, {
    generation: state.generation,
    revision: state.revision,
  })
}

export async function getKeyStatus(
  files: KeyFiles = keyFiles,
): Promise<{ keys: number; synchronized: boolean }> {
  const state = parseKeyStore(await files.source.read().once())
  const [receipt, authorized] = await Promise.all([
    files.applied
      .read()
      .once()
      .catch(() => null),
    files.authorized.read().once(),
  ])
  return {
    keys: state.keys.length,
    synchronized: Boolean(
      receipt &&
      receipt.generation === state.generation &&
      receipt.revision === state.revision &&
      (authorized ?? '') === renderKeys(state.keys),
    ),
  }
}

export async function changeKeys(
  effects: types.Effects,
  change: (keys: SshKey[]) => SshKey[],
  files: KeyFiles = keyFiles,
  timeoutMs = 15000,
) {
  let revision = 0
  let generation = ''
  await files.store.update(effects, (current) => {
    const state = current ?? newKeyStore()
    revision = state.revision + 1
    generation = state.generation
    const next = { ...state, keys: change(state.keys), revision }
    return parseKeyStore(JSON.stringify(next))
  })
  const abort = new AbortController()
  const timeout = setTimeout(() => abort.abort(), timeoutMs)
  try {
    await files.applied
      .read()
      .waitFor(
        effects,
        (receipt) =>
          Boolean(
            receipt &&
            receipt.generation === generation &&
            receipt.revision >= revision,
          ),
        abort.signal,
      )
  } catch {
    throw new Error(
      'The key change was saved but SSH synchronization has not completed. Check service initialization and list the registered keys before retrying.',
    )
  } finally {
    clearTimeout(timeout)
  }
}

export function validateLabel(input: string) {
  const label = input.trim()
  if (!label || label.length > 80 || /[\u0000-\u001f\u007f]/u.test(label)) {
    throw new Error(
      'Use a label of 1 to 80 characters without control characters.',
    )
  }
  return label
}

export function renderKeys(keys: Array<{ publicKey: string }>) {
  return keys
    .map((key) => `${parsePublicKey(key.publicKey).publicKey}\n`)
    .join('')
}
