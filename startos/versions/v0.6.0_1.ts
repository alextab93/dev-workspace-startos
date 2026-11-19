import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v0_6_0_1 = VersionInfo.of({
  version: '0.6.0:1',
  releaseNotes: {
    en_US:
      'Prefer enabled mDNS addresses for Web Preview links and keep long application names within the sign-in page.',
    es_ES:
      'Prioriza las direcciones mDNS habilitadas en los enlaces de las vistas previas web y ajusta los nombres largos en la página de acceso.',
    de_DE:
      'Bevorzugt aktivierte mDNS-Adressen für Web-Vorschau-Links und hält lange Anwendungsnamen innerhalb der Anmeldeseite.',
    pl_PL:
      'Preferuje włączone adresy mDNS w odnośnikach podglądu WWW i dopasowuje długie nazwy aplikacji do strony logowania.',
    fr_FR:
      'Privilégie les adresses mDNS activées pour les liens des aperçus Web et adapte les noms longs à la page de connexion.',
  },
  migrations: { up: async () => {}, down: IMPOSSIBLE },
})
