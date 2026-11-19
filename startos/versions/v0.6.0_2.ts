import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v0_6_0_2 = VersionInfo.of({
  version: '0.6.0:2',
  releaseNotes: {
    en_US:
      'Show the remaining lifetime of Web Previews and explain how to refresh it.',
    es_ES:
      'Muestra el tiempo restante de las vistas previas web y explica cómo actualizarlo.',
    de_DE:
      'Zeigt die verbleibende Laufzeit von Web-Vorschauen und erklärt die Aktualisierung.',
    pl_PL:
      'Pokazuje pozostały czas podglądów WWW i wyjaśnia, jak go odświeżyć.',
    fr_FR:
      'Affiche la durée restante des aperçus Web et explique comment la mettre à jour.',
  },
  migrations: { up: async () => {}, down: IMPOSSIBLE },
})
