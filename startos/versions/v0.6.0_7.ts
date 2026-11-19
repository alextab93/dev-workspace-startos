import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v0_6_0_7 = VersionInfo.of({
  version: '0.6.0:7',
  releaseNotes: {
    en_US:
      'Keep SSH available when the workspace Podman engine is unavailable.',
    es_ES: 'Mantiene SSH disponible cuando el motor Podman no está disponible.',
    de_DE: 'SSH bleibt verfügbar, wenn die Podman-Engine nicht erreichbar ist.',
    pl_PL: 'SSH pozostaje dostępne, gdy silnik Podman jest niedostępny.',
    fr_FR: 'SSH reste disponible lorsque le moteur Podman est indisponible.',
  },
  migrations: { up: async () => {}, down: IMPOSSIBLE },
})
