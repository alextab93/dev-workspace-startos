import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v0_4_0_0 = VersionInfo.of({
  version: '0.4.0:0',
  releaseNotes: {
    en_US:
      'Discover Nextcloud automatically, connect through browser approval, and choose an existing project folder.',
    es_ES:
      'Detecta Nextcloud automáticamente, conecta la cuenta desde el navegador y elige una carpeta de proyectos existente.',
    de_DE:
      'Nextcloud automatisch finden, Konto im Browser verbinden und einen vorhandenen Projektordner auswählen.',
    pl_PL:
      'Automatyczne wykrywanie Nextcloud, łączenie konta w przeglądarce i wybór istniejącego folderu projektu.',
    fr_FR:
      'Détection automatique de Nextcloud, connexion du compte dans le navigateur et choix du dossier de projet.',
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
