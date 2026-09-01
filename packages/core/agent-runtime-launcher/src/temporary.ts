/** Owner-only temporary launch material with restart scavenging metadata. */

import { randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  unlink,
} from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { RuntimeTemporaryFile } from './types.ts'

const OWNER = 'dsh-agent-runtime-launcher-v1'
const METADATA = 'owner.json'
const RUN_PREFIX = 'run-'

interface CleanupMetadata {
  readonly owner: typeof OWNER
  readonly pid: number
  readonly files: readonly string[]
}

function isCleanupMetadata(value: unknown): value is CleanupMetadata {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<CleanupMetadata>
  return candidate.owner === OWNER
    && Number.isSafeInteger(candidate.pid)
    && (candidate.pid ?? 0) > 0
    && Array.isArray(candidate.files)
    && candidate.files.every(file => typeof file === 'string')
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function unlinkLinkOrRemoveDirectory(path: string): Promise<void> {
  const info = await lstat(path)
  if (info.isSymbolicLink()) {
    await unlink(path)
    return
  }
  if (!info.isDirectory()) throw new Error(`temporary launch material is not a directory: ${path}`)
  await rm(path, { recursive: true })
}

/** One created launch directory and its non-secret file-path mapping. */
export interface RuntimeTemporaryMaterial {
  readonly paths: Readonly<Record<string, string>>
  cleanup(): Promise<void>
}

/** Installation-scoped owner for runtime authentication and protocol files. */
export class RuntimeTemporaryMaterialOwner {
  constructor(
    private readonly root: string,
    private readonly processAlive: (pid: number) => boolean = defaultProcessAlive,
  ) {}

  /** Create the private root and remove stale owned launch directories. */
  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await chmod(this.root, 0o700)
    const entries = await readdir(this.root, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.name.startsWith(RUN_PREFIX)) continue
      const path = join(this.root, entry.name)
      const info = await lstat(path)
      if (info.isSymbolicLink()) {
        await unlink(path)
        continue
      }
      if (!info.isDirectory()) continue
      const metadataPath = join(path, METADATA)
      let metadata: unknown
      try {
        const metadataInfo = await lstat(metadataPath)
        if (!metadataInfo.isFile() || metadataInfo.isSymbolicLink()) continue
        metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as unknown
      } catch {
        continue
      }
      if (!isCleanupMetadata(metadata) || this.processAlive(metadata.pid)) continue
      await unlinkLinkOrRemoveDirectory(path)
    }
  }

  /**
   * Create one random private launch directory and exclusive owner-only files.
   * @param files - sensitive file payloads keyed by safe basenames.
   * @returns the live material owner.
   */
  async create(files: readonly RuntimeTemporaryFile[]): Promise<RuntimeTemporaryMaterial> {
    const names = new Set<string>()
    for (const file of files) {
      if (file.name.length === 0
        || file.name === '.'
        || file.name === '..'
        || file.name === METADATA
        || file.name.includes('\0')
        || basename(file.name) !== file.name
        || names.has(file.name)) {
        throw new Error(`invalid or duplicate runtime temporary filename: ${JSON.stringify(file.name)}`)
      }
      names.add(file.name)
    }
    const directory = join(this.root, `${RUN_PREFIX}${randomUUID()}`)
    await mkdir(directory, { mode: 0o700 })
    const metadata: CleanupMetadata = { owner: OWNER, pid: process.pid, files: [...names] }
    const metadataHandle = await open(join(directory, METADATA), 'wx', 0o600)
    try {
      await metadataHandle.writeFile(JSON.stringify(metadata))
    } finally {
      await metadataHandle.close()
    }
    const paths: Record<string, string> = {}
    try {
      for (const file of files) {
        const path = join(directory, file.name)
        const handle = await open(path, 'wx', 0o600)
        try {
          await handle.writeFile(file.content)
        } finally {
          await handle.close()
        }
        paths[file.name] = path
      }
    } catch (error: unknown) {
      await unlinkLinkOrRemoveDirectory(directory)
      throw error
    }
    let cleaned = false
    return {
      paths: Object.freeze({ ...paths }),
      cleanup: async () => {
        if (cleaned) return
        await unlinkLinkOrRemoveDirectory(directory)
        cleaned = true
      },
    }
  }
}
