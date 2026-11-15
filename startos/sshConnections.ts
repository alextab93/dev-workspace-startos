import { i18n } from './i18n'

export function sshConnectionHealth(output?: string) {
  try {
    const value: unknown = JSON.parse(output ?? '')
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      !('connections' in value) ||
      typeof value.connections !== 'number' ||
      !Number.isSafeInteger(value.connections) ||
      value.connections < 0
    ) {
      throw new Error('Invalid SSH connection count')
    }
    return {
      result: 'success' as const,
      message: i18n('SSH connections: ${count}', { count: value.connections }),
    }
  } catch {
    return {
      result: 'failure' as const,
      message: i18n('SSH connection count is unavailable.'),
    }
  }
}
