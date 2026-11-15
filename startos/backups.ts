import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { sdk } from './sdk'

export async function syncDockerStorage(
  source: string,
  destination: string,
  progress?: (percent: number) => void,
): Promise<void> {
  const from = path.resolve(source)
  const to = path.resolve(destination)
  if (
    from === to ||
    from.startsWith(`${to}${path.sep}`) ||
    to.startsWith(`${from}${path.sep}`)
  ) {
    throw new Error(
      'Docker backup source and destination must be separate directories.',
    )
  }
  const sourceStat = await fs.lstat(from).catch(() => null)
  if (!sourceStat?.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(
      'Docker backup source is missing or is not a directory. No destination data was changed.',
    )
  }
  await fs.mkdir(to, { recursive: true })
  const destinationStat = await fs.lstat(to)
  if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) {
    throw new Error('Docker backup destination is not a directory.')
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'rsync',
      [
        '-aAXH',
        '--numeric-ids',
        '--delete',
        '--partial',
        '--inplace',
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
      reject(new Error('Docker storage backup or restore could not start.'))
    })
    child.once('close', (code, signal) => {
      if (code === 0) {
        progress?.(100)
        resolve()
      } else {
        reject(
          new Error(
            `Docker storage backup or restore is incomplete (rsync ${signal ? `signal ${signal}` : `exit ${code}`}).`,
          ),
        )
      }
    })
  })
}

const dockerData = '/media/startos/volumes/docker'
const dockerBackup = '/media/startos/backup/volumes/docker'

export const { createBackup, restoreInit } = sdk.setupBackups(async () =>
  sdk.Backups.ofVolumes('main', 'home')
    .setPreBackup(async (_effects, progress) => {
      progress.setTotal(100)
      await syncDockerStorage(dockerData, dockerBackup, (percent) =>
        progress.setDone(percent),
      )
    })
    .setPostRestore(async (_effects, progress) => {
      progress.setTotal(100)
      await syncDockerStorage(dockerBackup, dockerData, (percent) =>
        progress.setDone(percent),
      )
    }),
)
