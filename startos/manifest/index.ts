import { setupManifest } from '@start9labs/start-sdk'
import { short, long } from './i18n'

export const manifest = setupManifest({
  id: 'dev-workspace',
  title: 'Dev Workspace',
  osVersion: '0.4.1',
  license: 'MIT',
  packageRepo: 'https://github.com/alextab93/dev-workspace-startos',
  upstreamRepo: 'https://github.com/openssh/openssh-portable',
  marketingUrl: 'https://code.visualstudio.com/docs/remote/ssh',
  donationUrl: null,
  description: { short, long },
  volumes: ['main', 'home', 'docker'],
  userspaceFilesystems: true,
  virtualNetworking: true,
  images: {
    workspace: {
      source: { dockerBuild: { workdir: '.' } },
      arch: ['x86_64', 'aarch64'],
      emulateMissing: false,
    },
  },
})
