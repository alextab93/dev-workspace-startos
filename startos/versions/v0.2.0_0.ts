import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v0_2_0_0 = VersionInfo.of({
  version: '0.2.0:0',
  releaseNotes: {
    en_US:
      'Add an optional FileBrowser Quantum folder for editing shared projects over SSH.',
    es_ES:
      'Agrega una carpeta opcional de FileBrowser Quantum para editar proyectos compartidos por SSH.',
    de_DE:
      'Optionaler FileBrowser-Quantum-Ordner zum Bearbeiten gemeinsamer Projekte über SSH.',
    pl_PL:
      'Opcjonalny folder FileBrowser Quantum do edycji współdzielonych projektów przez SSH.',
    fr_FR:
      'Dossier FileBrowser Quantum facultatif pour modifier des projets partagés via SSH.',
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
