import {
  ExtendedVersion,
  FileHelper,
  utils,
  VersionRange,
  z,
  type T,
} from '@start9labs/start-sdk'
import { sdk } from './sdk'
import { i18n } from './i18n'
import {
  NEXTCLOUD_VERSION_RANGE,
  normalizeNextcloudUrl,
  readProjectSource,
} from './projectSource'

const connectionDirectory = '/var/lib/dev-workspace/nextcloud-connection'
const connectionConfigPath = '/run/dev-workspace-nextcloud-connect/config.json'
const identitySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u)
const accountSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/[:\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value))
const passwordSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value))

function normalizeBaseUrl(input: string): string {
  const url = new URL(input)
  if (
    input.length > 2048 ||
    input.trim() !== input ||
    /[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input) ||
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('Invalid Nextcloud address')
  }
  return url.toString().replace(/\/+$/u, '')
}

const baseUrlSchema = z.string().transform((value, context) => {
  try {
    return normalizeBaseUrl(value)
  } catch {
    context.addIssue({ code: 'custom', message: 'Invalid Nextcloud address' })
    return z.NEVER
  }
})

const webdavUrlSchema = z.string().transform((value, context) => {
  try {
    return normalizeNextcloudUrl(value)
  } catch {
    context.addIssue({ code: 'custom', message: 'Invalid Nextcloud address' })
    return z.NEVER
  }
})

const httpsUrlSchema = z
  .string()
  .min(1)
  .max(8192)
  .refine((value) => {
    try {
      const url = new URL(value)
      return (
        url.protocol === 'https:' &&
        Boolean(url.hostname) &&
        !url.username &&
        !url.password &&
        !url.hash &&
        !/[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
      )
    } catch {
      return false
    }
  })

const pathSchema = z
  .string()
  .max(1024)
  .refine(
    (value) =>
      value === '' ||
      (!value.startsWith('/') &&
        !/^[A-Za-z]:/u.test(value) &&
        !/[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) &&
        value
          .split('/')
          .every(
            (part) => part.trim().length > 0 && part !== '.' && part !== '..',
          )),
  )

const savedConnectionSchema = z.looseObject({
  id: identitySchema,
  url: webdavUrlSchema,
  username: accountSchema,
  appPassword: passwordSchema,
  accountId: accountSchema,
  displayName: z.string().max(1024),
  internalBaseUrl: baseUrlSchema,
})

export const nextcloudConnectionSchema = z.looseObject({
  version: z.literal(1),
  browsePath: pathSchema,
  pending: z
    .looseObject({
      id: identitySchema,
      state: z.enum(['waiting', 'received']),
      createdAt: z.number().finite().nonnegative(),
      expiresAt: z.number().finite().nonnegative(),
      internalBaseUrl: baseUrlSchema,
      browserBaseUrl: baseUrlSchema,
      allowedBaseUrls: z.array(baseUrlSchema).min(1).max(128),
      loginUrl: httpsUrlSchema,
      pollEndpoint: httpsUrlSchema,
      pollToken: z.string().min(1).max(4096),
      username: accountSchema.optional(),
      appPassword: passwordSchema.optional(),
    })
    .optional(),
  connection: savedConnectionSchema.optional(),
  retiredConnections: z.array(savedConnectionSchema).max(16).optional(),
})

export type NextcloudConnectionState = z.infer<typeof nextcloudConnectionSchema>

export const nextcloudConnectionFile = FileHelper.json(
  { base: sdk.volumes.main, subpath: './nextcloud-connection/state.json' },
  nextcloudConnectionSchema,
)

export async function readNextcloudConnection(
  effects?: T.Effects,
  file = nextcloudConnectionFile,
): Promise<NextcloudConnectionState | null> {
  try {
    const reader = file.read()
    return effects ? await reader.const(effects) : await reader.once()
  } catch {
    throw new Error(
      i18n(
        'Nextcloud account settings are invalid. Connect your account again.',
      ),
    )
  }
}

export type NextcloudEndpoints = {
  internalBaseUrl: string
  browserBaseUrl: string
  allowedBaseUrls: string[]
}

function nextcloudCandidates(host: T.Host | null) {
  const binding = host?.bindings[80]
  const iface = binding?.interfaces.ui
  if (!host || !binding?.enabled || !iface) return []
  const address = utils.filledAddress(host, iface.addressInfo).nonLocal
  return address.hostnames
    .filter((hostname) => hostname.ssl)
    .flatMap((hostname) => {
      const url = baseUrlSchema.safeParse(address.toUrl(hostname))
      return url.success ? [{ hostname, url: url.data }] : []
    })
}

function chooseNextcloudTransport(
  candidates: ReturnType<typeof nextcloudCandidates>,
  preferredOrigin?: string,
) {
  const preferred = baseUrlSchema.safeParse(preferredOrigin)
  const rank = (candidate: (typeof candidates)[number]) =>
    preferred.success && candidate.url === preferred.data
      ? 0
      : !candidate.hostname.public &&
          candidate.hostname.metadata.kind === 'ipv4'
        ? 1
        : !candidate.hostname.public &&
            candidate.hostname.metadata.kind === 'ipv6'
          ? 2
          : candidate.hostname.metadata.kind === 'public-domain'
            ? 3
            : candidate.hostname.metadata.kind === 'mdns'
              ? 4
              : 5
  return (
    [...candidates].sort((left, right) => rank(left) - rank(right))[0]?.url ??
    null
  )
}

export async function resolveNextcloudTransport(
  effects: T.Effects,
  preferredOrigin?: string,
  reactive = false,
): Promise<string> {
  const address = sdk.host.get(
    effects,
    { packageId: 'nextcloud', hostId: 'main' },
    (host) =>
      chooseNextcloudTransport(nextcloudCandidates(host), preferredOrigin),
  )
  const selected = reactive ? await address.const() : await address.once()
  if (!selected) {
    throw new Error(
      i18n('Nextcloud is unavailable. Start Nextcloud and try again.'),
    )
  }
  return selected
}

export async function resolveNextcloud(
  effects: T.Effects,
  preferredOrigin?: string,
): Promise<NextcloudEndpoints> {
  const manifest = await sdk.getServiceManifest(effects, 'nextcloud').once()
  if (
    !manifest ||
    !VersionRange.parse(NEXTCLOUD_VERSION_RANGE).satisfiedByRelease(
      [manifest.version, ...manifest.satisfies].map((version) =>
        ExtendedVersion.parse(version),
      ),
    )
  ) {
    throw new Error(
      i18n('Install a compatible Nextcloud package before selecting it.'),
    )
  }
  const [bridge, host] = await Promise.all([
    sdk.host
      .getBridgeAddress(effects, {
        packageId: 'nextcloud',
        hostId: 'main',
        internalPort: 80,
        ssl: true,
      })
      .once(),
    sdk.host.get(effects, { packageId: 'nextcloud', hostId: 'main' }).once(),
  ])
  if (!host?.bindings[80]?.enabled) {
    throw new Error(
      i18n('Nextcloud is unavailable. Start Nextcloud and try again.'),
    )
  }
  const iface = host.bindings[80]?.interfaces.ui
  const candidates = nextcloudCandidates(host)
  if (!candidates.length) {
    throw new Error(
      i18n(
        'Nextcloud has no enabled HTTPS address for account authorization. Enable one in its Interfaces settings.',
      ),
    )
  }
  const preferred = baseUrlSchema.safeParse(iface?.preferredLauncherAddress)
  const rank = (candidate: (typeof candidates)[number]) =>
    preferred.success && candidate.url === preferred.data
      ? 0
      : candidate.hostname.metadata.kind === 'public-domain'
        ? 1
        : candidate.hostname.metadata.kind === 'mdns'
          ? 2
          : 3
  candidates.sort((left, right) => rank(left) - rank(right))
  const internalBaseUrl = chooseNextcloudTransport(candidates, preferredOrigin)!
  const bridgeUrl = bridge && baseUrlSchema.safeParse(`https://${bridge}`)
  return {
    internalBaseUrl,
    browserBaseUrl: candidates[0].url,
    allowedBaseUrls: Array.from(
      new Set([
        internalBaseUrl,
        ...candidates.map((candidate) => candidate.url),
        ...(bridgeUrl && bridgeUrl.success ? [bridgeUrl.data] : []),
      ]),
    ),
  }
}

const publicConnectionSchema = z.object({
  id: identitySchema,
  accountId: accountSchema,
  displayName: z.string().max(1024),
})

const publicResultSchema = z.object({
  ok: z.literal(true),
  state: z.enum([
    'disconnected',
    'waiting',
    'expired',
    'received',
    'connected',
  ]),
  pending: z
    .object({
      id: identitySchema,
      authorizationUrl: httpsUrlSchema,
      expiresAt: z.number().finite().nonnegative(),
    })
    .nullable(),
  connection: publicConnectionSchema.nullable(),
  path: pathSchema.optional(),
  parentPath: pathSchema.nullable().optional(),
  canSelect: z.boolean().optional(),
  folders: z
    .array(
      z.object({
        name: z.string().min(1).max(1024),
        path: pathSchema,
        canSelect: z.boolean(),
      }),
    )
    .max(4096)
    .optional(),
})

export type NextcloudConnectionResult = z.infer<typeof publicResultSchema>
export type NextcloudConnectionOperation =
  | 'begin'
  | 'poll'
  | 'browse'
  | 'status'
  | 'cancel'

export class NextcloudConnectionError extends Error {
  constructor(readonly code: string) {
    super(connectionErrorMessage(code))
    this.name = 'NextcloudConnectionError'
  }
}

function connectionErrorMessage(code: string) {
  if (code === 'not-connected')
    return i18n('Connect your Nextcloud account, then choose a project folder.')
  if (code === 'authentication-failed')
    return i18n(
      'Reconnect your Nextcloud account. If account setup is unfinished, cancel it first.',
    )
  if (code === 'connection-limit')
    return i18n(
      'Revoke old Dev Workspace grants in Nextcloud Security settings, then connect again.',
    )
  if (code === 'busy')
    return i18n(
      'Another Nextcloud connection operation is in progress. Try again shortly.',
    )
  if (code === 'service-address-changed')
    return i18n(
      'The Nextcloud address changed during account setup. Let the authorization link expire, then connect again.',
    )
  if (code === 'folder-missing' || code === 'invalid-folder')
    return i18n(
      'The Nextcloud folder is unavailable or unreadable. Check Nextcloud and choose an accessible folder again.',
    )
  return i18n(
    'Nextcloud account connection could not be completed. Check Nextcloud and try again.',
  )
}

export function parseNextcloudConnectionResult(
  raw: string,
  exitCode: number | null = 0,
): NextcloudConnectionResult {
  try {
    if (raw.length > 4 * 1024 * 1024) {
      throw new NextcloudConnectionError('invalid_response')
    }
    const value: unknown = JSON.parse(raw)
    const error = z
      .object({
        ok: z.literal(false),
        code: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
      })
      .safeParse(value)
    if (error.success) throw new NextcloudConnectionError(error.data.code)
    if (exitCode !== 0) throw new NextcloudConnectionError('command_failed')
    const result = publicResultSchema.safeParse(value)
    if (!result.success) throw new NextcloudConnectionError('invalid_response')
    return result.data
  } catch (error) {
    if (error instanceof NextcloudConnectionError) throw error
    throw new NextcloudConnectionError('invalid_response')
  }
}

export async function runNextcloudConnection(
  effects: T.Effects,
  operation: NextcloudConnectionOperation,
  path?: string,
): Promise<NextcloudConnectionResult> {
  if (path !== undefined && !pathSchema.safeParse(path).success) {
    throw new NextcloudConnectionError('invalid_path')
  }
  const connection = await readNextcloudConnection()
  const endpoints = await resolveNextcloud(
    effects,
    connection?.pending?.internalBaseUrl ??
      connection?.connection?.internalBaseUrl,
  )
  const source = await readProjectSource()
  const activeConnectionId =
    source.provider === 'nextcloud' && typeof source.connectionId === 'string'
      ? source.connectionId
      : null
  try {
    const rootCa = await sdk.getRootCa(effects)
    return await sdk.SubContainer.withTemp(
      effects,
      { imageId: 'workspace' },
      sdk.Mounts.of().mountVolume({
        volumeId: 'main',
        subpath: './nextcloud-connection',
        mountpoint: connectionDirectory,
        readonly: false,
      }),
      `nextcloud-connect-${operation}`,
      async (container) => {
        await container.execFail(
          [
            'install',
            '-d',
            '-m',
            '0700',
            '/run/dev-workspace-nextcloud-connect',
          ],
          { user: 'root' },
        )
        await container.writeFile(
          connectionConfigPath,
          JSON.stringify({
            ...endpoints,
            rootCa,
            activeConnectionId,
            ...(path !== undefined ? { path } : {}),
          }),
          { mode: 0o600 },
        )
        const result = await container.exec(
          [
            '/usr/local/bin/nextcloud-connect',
            operation,
            '--config',
            connectionConfigPath,
            '--state-dir',
            connectionDirectory,
          ],
          { user: 'root', timeout: 60000 },
        )
        return parseNextcloudConnectionResult(
          String(result.stdout),
          result.exitCode,
        )
      },
    )
  } catch (error) {
    if (error instanceof NextcloudConnectionError) throw error
    throw new NextcloudConnectionError('command_failed')
  }
}
