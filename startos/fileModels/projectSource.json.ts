import { i18n } from '../i18n'
import { FileHelper, z } from '@start9labs/start-sdk'
import { sdk } from '../sdk'

const subpathMessage = i18n(
  'Choose a nonempty relative folder inside the selected provider. Use forward slashes between folders, without empty components, dot components, backslashes, or control characters.',
)

const subpathSchema = z
  .string()
  .max(1024)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !/^[A-Za-z]:/u.test(value) &&
      !/[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) &&
      value
        .split('/')
        .every(
          (part) => part.trim().length > 0 && part !== '.' && part !== '..',
        ),
    { message: subpathMessage },
  )

export function normalizeProjectSubpath(input: string): string {
  const result = subpathSchema.safeParse(input)
  if (!result.success) throw new Error(subpathMessage)
  return result.data
}

const nextcloudUrlMessage = i18n(
  'Enter the complete HTTPS WebDAV URL from Nextcloud Files settings, ending in /remote.php/dav/files/your-user/. Do not include a password, query, or fragment.',
)

export function normalizeNextcloudUrl(input: string): string {
  try {
    if (
      input.length > 2048 ||
      input.trim() !== input ||
      /[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input)
    ) {
      throw new Error(nextcloudUrlMessage)
    }
    const url = new URL(input)
    if (
      url.protocol !== 'https:' ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error(nextcloudUrlMessage)
    }
    const segments = url.pathname.split('/').filter(Boolean)
    for (const segment of segments) {
      const decoded = decodeURIComponent(segment)
      if (
        !decoded.trim() ||
        decoded === '.' ||
        decoded === '..' ||
        /[/\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(decoded)
      ) {
        throw new Error(nextcloudUrlMessage)
      }
    }
    if (!/\/remote\.php\/dav\/files\/[^/]+\/?$/u.test(url.pathname)) {
      throw new Error(nextcloudUrlMessage)
    }
    url.pathname = url.pathname.replace(/\/?$/u, '/')
    return url.toString()
  } catch {
    throw new Error(nextcloudUrlMessage)
  }
}

const nextcloudUrlSchema = z.string().transform((value, context) => {
  try {
    return normalizeNextcloudUrl(value)
  } catch {
    context.addIssue({ code: 'custom', message: nextcloudUrlMessage })
    return z.NEVER
  }
})

const usernameSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      value.trim().length > 0 && !/[:\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value),
  )

const appPasswordSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      value.trim().length > 0 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value),
  )

const accountIdSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      value.trim().length > 0 &&
      value !== '.' &&
      value !== '..' &&
      !/[/\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value),
  )

const connectionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u)

const cacheIdentitySchema = z.strictObject({
  url: nextcloudUrlSchema,
  username: usernameSchema,
  subpath: subpathSchema,
})

const nextcloudSourceSchema = z
  .looseObject({
    provider: z.literal('nextcloud'),
    url: nextcloudUrlSchema,
    username: usernameSchema,
    appPassword: appPasswordSchema,
    subpath: subpathSchema,
    discovery: z.literal('startos').optional(),
    accountId: accountIdSchema.optional(),
    connectionId: connectionIdSchema.optional(),
    cacheIdentity: cacheIdentitySchema.optional(),
  })
  .superRefine((value, context) => {
    const metadata = [
      value.discovery,
      value.accountId,
      value.connectionId,
      value.cacheIdentity,
    ]
    if (
      (metadata.some((field) => field !== undefined) &&
        metadata.some((field) => field === undefined)) ||
      (value.cacheIdentity && value.cacheIdentity.subpath !== value.subpath)
    ) {
      context.addIssue({
        code: 'custom',
        message: i18n(
          'The saved Nextcloud account connection is invalid. Connect your account again.',
        ),
      })
    }
  })

export const sourceSchema = z.discriminatedUnion('provider', [
  z.looseObject({ provider: z.literal('none') }),
  z.looseObject({
    provider: z.literal('filebrowser'),
    subpath: subpathSchema,
  }),
  nextcloudSourceSchema,
])

export type ProjectSource = z.infer<typeof sourceSchema>

export const projectSourceFile = FileHelper.json(
  { base: sdk.volumes.main, subpath: './project-source.json' },
  sourceSchema,
)

const rawSourceSchema = z.object({ raw: z.string() })

export const projectSourceFiles = {
  store: projectSourceFile,
  source: FileHelper.raw(
    projectSourceFile.path,
    (value: z.infer<typeof rawSourceSchema>) => value.raw,
    (raw) => ({ raw }),
    (value) => rawSourceSchema.parse(value),
  ),
}

export type ProjectSourceFiles = typeof projectSourceFiles
