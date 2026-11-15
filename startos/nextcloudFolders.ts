import { normalizeProjectSubpath } from './projectSource'

export type FolderListing = {
  connection: { id: string; accountId: string; displayName: string } | null
  path: string
  parentPath: string | null
  canSelect: boolean
  folders: { name: string; path: string; canSelect: boolean }[]
}

export type FolderChoice = {
  connectionId: string
  operation: 'select' | 'browse'
  path: string
}

export function folderChoices(listing: FolderListing): FolderChoice[] {
  if (!listing.connection) return []
  const connectionId = listing.connection.id
  const choices: FolderChoice[] = []
  if (listing.path && listing.canSelect) {
    choices.push({ connectionId, operation: 'select', path: listing.path })
  }
  if (listing.parentPath !== null) {
    choices.push({
      connectionId,
      operation: 'browse',
      path: listing.parentPath,
    })
  }
  for (const folder of listing.folders) {
    if (folder.canSelect)
      choices.push({ connectionId, operation: 'select', path: folder.path })
    choices.push({ connectionId, operation: 'browse', path: folder.path })
  }
  return choices
}

export function parseFolderChoice(raw: string): FolderChoice {
  try {
    const value = JSON.parse(raw) as FolderChoice
    if (
      !value ||
      typeof value.connectionId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(value.connectionId) ||
      !['select', 'browse'].includes(value.operation) ||
      typeof value.path !== 'string'
    )
      throw new Error('Invalid choice')
    if (value.path || value.operation === 'select')
      normalizeProjectSubpath(value.path)
    return {
      connectionId: value.connectionId,
      operation: value.operation,
      path: value.path,
    }
  } catch {
    throw new Error('Choose a folder from the current Nextcloud account.')
  }
}
