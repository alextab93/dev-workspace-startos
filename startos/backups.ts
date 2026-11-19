import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { sdk } from './sdk'

async function validateVolumePaths(source: string, destination: string) {
  const from = path.resolve(source)
  const to = path.resolve(destination)
  if (
    from === to ||
    from.startsWith(`${to}${path.sep}`) ||
    to.startsWith(`${from}${path.sep}`)
  ) {
    throw new Error(
      'Volume backup source and destination must be separate directories.',
    )
  }
  const sourceStat = await fs.lstat(from).catch(() => null)
  if (!sourceStat?.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(
      'Volume backup source is missing or is not a directory. Copy cannot proceed.',
    )
  }
  const destinationStat = await fs
    .lstat(to)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
  if (destinationStat && !destinationStat.isDirectory()) {
    throw new Error('Volume backup destination is not a directory.')
  }
}

export async function syncStorage(
  source: string,
  destination: string,
  progress?: (percent: number) => void,
  includeDevices = true,
): Promise<void> {
  const from = path.resolve(source)
  const to = path.resolve(destination)
  await validateVolumePaths(from, to)
  await fs.mkdir(to, { recursive: true })
  const destinationStat = await fs.lstat(to)
  if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) {
    throw new Error('Volume backup destination is not a directory.')
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'rsync',
      [
        includeDevices ? '-aAXH' : '-rlptgoAXH',
        '--super',
        '--numeric-ids',
        '--ignore-times',
        '--delete',
        '--timeout=300',
        '--info=progress2',
        '--',
        `${from}/`,
        `${to}/`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let highest = 0
    child.stdout.on('data', (data: Buffer) => {
      for (const match of data.toString().matchAll(/([0-9]+)%/g)) {
        highest = Math.max(highest, Math.min(99, Number(match[1])))
        progress?.(highest)
      }
    })
    child.stderr.resume()
    child.once('error', () => {
      reject(new Error('Volume backup or restore could not start.'))
    })
    child.once('close', (code, signal) => {
      if (code === 0) {
        progress?.(100)
        resolve()
      } else {
        reject(
          new Error(
            `Volume backup or restore is incomplete (rsync ${signal ? `signal ${signal}` : `exit ${code}`}).`,
          ),
        )
      }
    })
  })
}

const dataRoot = '/media/startos/volumes'
const backupRoot = '/media/startos/backup/volumes'
const volumes = ['docker', 'main', 'home'] as const

async function copyVolumes(
  from: string,
  to: string,
  report: (completed: number) => void,
) {
  for (const volume of volumes) {
    await validateVolumePaths(path.join(from, volume), path.join(to, volume))
  }
  for (const [index, volume] of volumes.entries()) {
    await syncStorage(
      path.join(from, volume),
      path.join(to, volume),
      (percent) => report(index * 100 + percent),
      volume === 'docker',
    )
  }
}

export const { createBackup, restoreInit } = sdk.setupBackups(async () =>
  sdk.Backups.ofVolumes()
    .setPreBackup(async (_effects, progress) => {
      progress.setTotal(volumes.length * 100)
      await copyVolumes(dataRoot, backupRoot, (n) => progress.setDone(n))
    })
    .setPreRestore(async (_effects, progress) => {
      progress.setTotal(volumes.length * 100)
      await copyVolumes(backupRoot, dataRoot, (n) => progress.setDone(n))
    }),
)
