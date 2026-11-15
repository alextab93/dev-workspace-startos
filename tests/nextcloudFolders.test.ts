import assert from 'node:assert/strict'
import { test } from 'node:test'
import { folderChoices, parseFolderChoice } from '../startos/nextcloudFolders'

const connection = {
  id: 'connection-one',
  accountId: 'developer',
  displayName: 'Developer',
}

test('root picker offers writable project folders and browsing without selecting the whole account', () => {
  const result = folderChoices({
    connection,
    path: '',
    parentPath: null,
    canSelect: false,
    folders: [
      { name: 'Projects', path: 'Projects', canSelect: true },
      { name: 'Read only', path: 'Read only', canSelect: false },
    ],
  })
  assert.deepEqual(result, [
    { connectionId: 'connection-one', operation: 'select', path: 'Projects' },
    { connectionId: 'connection-one', operation: 'browse', path: 'Projects' },
    { connectionId: 'connection-one', operation: 'browse', path: 'Read only' },
  ])
})

test('nested picker preserves exact names and offers parent navigation', () => {
  const result = folderChoices({
    connection,
    path: 'Projects',
    parentPath: '',
    canSelect: true,
    folders: [
      {
        name: 'Aplicación #1 %',
        path: 'Projects/Aplicación #1 %',
        canSelect: true,
      },
    ],
  })
  assert.deepEqual(result[0], {
    connectionId: 'connection-one',
    operation: 'select',
    path: 'Projects',
  })
  assert.deepEqual(result[1], {
    connectionId: 'connection-one',
    operation: 'browse',
    path: '',
  })
  for (const choice of result)
    assert.deepEqual(parseFolderChoice(JSON.stringify(choice)), choice)
})

test('folder choices reject missing account, traversal, account roots and unknown operations', () => {
  assert.deepEqual(
    folderChoices({
      connection: null,
      path: '',
      parentPath: null,
      canSelect: false,
      folders: [],
    }),
    [],
  )
  for (const value of [
    null,
    {},
    { connectionId: '', operation: 'select', path: 'Projects' },
    { connectionId: 'connection-one', operation: 'select', path: '' },
    { connectionId: 'connection-one', operation: 'select', path: '../outside' },
    { connectionId: 'connection-one', operation: 'remove', path: 'Projects' },
  ]) {
    assert.throws(
      () => parseFolderChoice(JSON.stringify(value)),
      /Choose a folder/,
    )
  }
})
