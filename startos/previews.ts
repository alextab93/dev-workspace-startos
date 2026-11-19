import { randomBytes, randomUUID, scrypt } from 'node:crypto'
import { promisify } from 'node:util'
import { type T, utils } from '@start9labs/start-sdk'
import {
  previewCapacity,
  previewConfigSchema,
  previewFiles,
  previewPortStart,
  previewRuntimeFile,
  type PreviewConfig,
  type PreviewFiles,
  type WebPreview,
} from './fileModels/previews.json'
import { sshPort } from './utils'
import { sdk } from './sdk'
import { parsePreviewSettings } from '../assets/preview-config.mjs'

const derive = promisify(scrypt)

export function previewHostId(id: string) {
  return `preview-${id}`
}

export async function previewUrls(effects: T.Effects, lease: WebPreview) {
  const hostId = previewHostId(lease.id)
  const host = await sdk.host.getOwn(effects, hostId).once()
  if (!host?.bindings[lease.proxyPort]?.enabled) return []
  const addresses = utils.filledAddress(host, {
    hostId,
    internalPort: lease.proxyPort,
    scheme: 'http',
    sslScheme: 'https',
    username: null,
    suffix: '',
  }).nonLocal
  return addresses.hostnames
    .filter((value) => value.ssl)
    .sort(
      (left, right) =>
        Number(right.metadata.kind === 'mdns') -
        Number(left.metadata.kind === 'mdns'),
    )
    .map(addresses.toUrl)
}

export async function readPreviewRuntime(file = previewRuntimeFile) {
  const value = await file
    .read()
    .once()
    .catch(() => null)
  const age = value ? Date.now() - value.observedAt : null
  return age !== null && age >= 0 && age < 15000 ? value : null
}

export function emptyPreviewConfig(): PreviewConfig {
  return {
    version: 1,
    revision: 0,
    auth: null,
    leases: [],
    retired: [],
    quarantined: [],
  }
}

export function validateApplicationPort(port: number) {
  if (
    !Number.isSafeInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    port === sshPort ||
    (port >= previewPortStart && port < previewPortStart + previewCapacity)
  ) {
    throw new Error(
      'Choose an application port from 1024 to 65535, excluding SSH and preview listener ports.',
    )
  }
  return port
}

export function validatePreviewName(value: string) {
  const name = value.trim()
  if (!name || name.length > 60 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new Error(
      'Use a preview name of 1 to 60 characters without control characters.',
    )
  }
  return name
}

export function validatePreviewDuration(minutes: number) {
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1440) {
    throw new Error('Choose a preview duration from 1 to 1440 minutes.')
  }
  return minutes
}

export function parsePreviewConfig(raw: string | null): PreviewConfig {
  if (raw === null) return emptyPreviewConfig()
  try {
    return previewConfigSchema.parse(parsePreviewSettings(JSON.parse(raw)))
  } catch (cause) {
    throw new Error(
      'Web Preview settings are invalid. Repair or restore the preview configuration. Project files have not been changed.',
      { cause },
    )
  }
}

export async function readPreviewConfig(
  effects?: T.Effects,
  files: PreviewFiles = previewFiles,
) {
  const reader = files.source.read()
  return parsePreviewConfig(
    effects ? await reader.const(effects) : await reader.once(),
  )
}

export async function setPreviewPassword(
  effects: T.Effects,
  files: PreviewFiles = previewFiles,
) {
  const password = randomBytes(24).toString('base64url')
  const salt = randomBytes(16).toString('hex')
  const hash = ((await derive(password, salt, 32)) as Buffer).toString('hex')
  await files.config.update(effects, (current) => {
    const state = parsePreviewConfig(
      current === null ? null : JSON.stringify(current),
    )
    return {
      ...state,
      revision: state.revision + 1,
      auth: { generation: randomUUID(), salt, hash },
    }
  })
  return password
}

function retireExpired(state: PreviewConfig, now: number) {
  const expired = state.leases.filter((lease) => lease.expiresAt <= now)
  return {
    ...state,
    leases: state.leases.filter((lease) => lease.expiresAt > now),
    retired: [...state.retired, ...expired.map((lease) => lease.id)],
  }
}

export async function addWebPreview(
  effects: T.Effects,
  input: { name: string; applicationPort: number; durationMinutes: number },
  files: PreviewFiles = previewFiles,
) {
  const name = validatePreviewName(input.name)
  const applicationPort = validateApplicationPort(input.applicationPort)
  const minutes = validatePreviewDuration(input.durationMinutes)
  let created: WebPreview | undefined
  await files.config.update(effects, (current) => {
    const now = Date.now()
    const state = retireExpired(
      parsePreviewConfig(current === null ? null : JSON.stringify(current)),
      now,
    )
    if (!state.auth)
      throw new Error('Use Set Web Preview Password before adding a preview.')
    if (state.quarantined.length)
      throw new Error(
        'Invalid preview records were quarantined. Use Remove Invalid Web Previews before adding another preview.',
      )
    if (state.retired.length > 0)
      throw new Error(
        'Preview interface cleanup is pending. Check service initialization before adding another preview.',
      )
    if (
      state.leases.some(
        (lease) =>
          lease.name.toLowerCase() === name.toLowerCase() ||
          lease.applicationPort === applicationPort,
      )
    ) {
      throw new Error(
        'A preview already uses this name or application port. Extend or remove that preview first.',
      )
    }
    const proxyPort = Array.from(
      { length: previewCapacity },
      (_, index) => previewPortStart + index,
    ).find((port) => !state.leases.some((lease) => lease.proxyPort === port))
    if (proxyPort === undefined)
      throw new Error(
        'Eight previews are already active. Remove one or wait for it to expire.',
      )
    created = {
      id: randomUUID(),
      name,
      applicationPort,
      proxyPort,
      createdAt: now,
      expiresAt: now + minutes * 60000,
    }
    return parsePreviewConfig(
      JSON.stringify({
        ...state,
        revision: state.revision + 1,
        leases: [...state.leases, created],
      }),
    )
  })
  return created!
}

export async function extendWebPreview(
  effects: T.Effects,
  id: string,
  durationMinutes: number,
  files: PreviewFiles = previewFiles,
) {
  const minutes = validatePreviewDuration(durationMinutes)
  let extended: WebPreview | undefined
  await files.config.update(effects, (current) => {
    const state = parsePreviewConfig(
      current === null ? null : JSON.stringify(current),
    )
    const now = Date.now()
    const lease = state.leases.find((lease) => lease.id === id)
    if (!lease || lease.expiresAt <= now)
      throw new Error(
        'This preview has expired or was removed. Create a new preview.',
      )
    extended = {
      ...lease,
      expiresAt: Math.max(lease.expiresAt, now + minutes * 60000),
    }
    return {
      ...state,
      revision: state.revision + 1,
      leases: state.leases.map((value) =>
        value.id === id ? extended! : value,
      ),
    }
  })
  return extended!
}

export async function removeWebPreview(
  effects: T.Effects,
  id: string,
  files: PreviewFiles = previewFiles,
) {
  await files.config.update(effects, (current) => {
    const state = parsePreviewConfig(
      current === null ? null : JSON.stringify(current),
    )
    if (!state.leases.some((lease) => lease.id === id))
      throw new Error('This preview has already expired or was removed.')
    return parsePreviewConfig(
      JSON.stringify({
        ...state,
        revision: state.revision + 1,
        leases: state.leases.filter((lease) => lease.id !== id),
        retired: [...state.retired, id],
      }),
    )
  })
}

export async function revokeRestoredPreviews(
  effects: T.Effects,
  files: PreviewFiles = previewFiles,
) {
  await files.config.update(effects, (current) => {
    if (current === null) return null
    const state = parsePreviewConfig(JSON.stringify(current))
    return {
      ...state,
      revision: state.revision + 1,
      auth: null,
      retired: [...state.retired, ...state.leases.map((lease) => lease.id)],
      leases: [],
    }
  })
}

export async function removeInvalidWebPreviews(
  effects: T.Effects,
  files: PreviewFiles = previewFiles,
) {
  let removed = 0
  await files.config.update(effects, (current) => {
    const state = parsePreviewConfig(
      current === null ? null : JSON.stringify(current),
    )
    removed = state.quarantined.length
    if (!removed) return null
    return { ...state, revision: state.revision + 1, quarantined: [] }
  })
  return removed
}
