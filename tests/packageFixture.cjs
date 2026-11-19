const {
  IMPOSSIBLE,
  StartSdk,
  VersionGraph,
  VersionInfo,
  buildManifest,
  setupManifest,
} = require('@start9labs/start-sdk')

const definition = setupManifest({
  id: 'workspace-runtime-fixture',
  title: 'Workspace Runtime Fixture',
  license: 'MIT',
  packageRepo: 'https://github.com/alextab93/dev-workspace-startos',
  upstreamRepo: 'https://github.com/alextab93/dev-workspace-startos',
  marketingUrl: null,
  donationUrl: null,
  description: {
    short: { en_US: 'Disposable package metadata for runtime tests.' },
    long: {
      en_US:
        'A signed metadata fixture without application images. Used only for package discovery and inspection tests.',
    },
  },
  volumes: [],
  images: {},
})

const versions = VersionGraph.of({
  current: VersionInfo.of({
    version: '1.0.0:0',
    releaseNotes: { en_US: 'Disposable metadata fixture.' },
    migrations: { up: async () => {}, down: IMPOSSIBLE },
  }),
  other: [],
})
const sdk = StartSdk.of().withManifest(definition).build(true)
process.stdout.write(
  JSON.stringify(buildManifest(versions, definition, sdk.Dependencies.of())) +
    '\n',
)
