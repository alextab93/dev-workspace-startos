import assert from 'node:assert/strict'
import { test } from 'node:test'
import { catalogValidator, packageScanStatistics } from '../startos/packages'

const catalog = {
  packages: [],
  errors: [],
  truncated: false,
  scannedAt: '2026-11-16T00:00:00Z',
  connected: false,
  architecture: 'x86_64',
}
const statistics = {
  durationSeconds: 4.25,
  limitsReached: ['depth'] as const,
  roots: [
    {
      path: '/projects-shared',
      status: 'incomplete',
      durationSeconds: 4,
      entriesVisited: 110,
      directoriesSkipped: 4,
      symlinksSkipped: 2,
      otherEntriesSkipped: 1,
      candidates: 105,
      packagesFound: 0,
      errors: 105,
      hashedBytes: 1048576,
      hashingSeconds: 2.5,
      inspectionSeconds: 1,
    },
  ],
}

test('older catalogs stay readable without invented scan measurements', () => {
  const value = catalogValidator.parse(catalog)
  assert.equal(value.statistics, null)
  assert.equal(
    packageScanStatistics(value.statistics, 0),
    'Scan statistics are unavailable for this catalog.',
  )
})

test('catalog statistics show measured counts, phase timing and omitted error totals', () => {
  const value = catalogValidator.parse({
    ...catalog,
    statistics,
    truncated: true,
  })
  assert.equal(
    packageScanStatistics(value.statistics, 100),
    [
      'Scan duration: 4.250 s. Limits reached: Directory depth.',
      'Scan errors: 105; shown below: 100.',
      '/projects-shared: Incomplete.\nEntries visited: 110. Candidates: 105; valid packages: 0. Excluded directories: 4; symlinks: 2; other entries: 1.\nDuration: 4.000 s. Hashed: 1048576 bytes in 2.500 s. Manifest inspection: 1.000 s.',
    ].join('\n\n'),
  )
})

test('catalog statistics reject impossible durations and negative counts', () => {
  assert.equal(
    catalogValidator.safeParse({
      ...catalog,
      statistics: { ...statistics, durationSeconds: Infinity },
    }).success,
    false,
  )
  assert.equal(
    catalogValidator.safeParse({
      ...catalog,
      statistics: {
        ...statistics,
        roots: [{ ...statistics.roots[0], hashedBytes: -1 }],
      },
    }).success,
    false,
  )
})
