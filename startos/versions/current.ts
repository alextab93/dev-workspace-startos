import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '0.6.0:11',
  releaseNotes: {
    en_US:
      'Import shared projects, export build artifacts, and read project release and container storage reports.',
    es_ES:
      'Importa proyectos compartidos, exporta archivos de compilación y consulta informes de versiones y almacenamiento.',
  },
  migrations: { up: async () => {}, down: IMPOSSIBLE },
})
