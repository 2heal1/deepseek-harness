import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { RuntimeTemporaryMaterialOwner } from '@deepseek-ai/dsh-agent-runtime-launcher'
import { afterEach, describe, expect, it, vi } from 'vitest'

const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-material-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('RuntimeTemporaryMaterialOwner', () => {
  it('creates owner-only material and cleans it idempotently', async () => {
    const root = await temporaryRoot()
    const owner = new RuntimeTemporaryMaterialOwner(root)
    await owner.initialize()
    const material = await owner.create([
      { name: 'auth.json', content: '{"token":"secret"}' },
      { name: 'binary', content: Uint8Array.from([0, 1, 2]) },
    ])
    const directory = dirname(material.paths['auth.json']!)

    expect(await readFile(material.paths['auth.json']!, 'utf8')).toBe('{"token":"secret"}')
    expect(await readFile(material.paths.binary!)).toEqual(Buffer.from([0, 1, 2]))
    if (process.platform !== 'win32') {
      expect((await stat(root)).mode & 0o777).toBe(0o700)
      expect((await stat(directory)).mode & 0o777).toBe(0o700)
      expect((await stat(material.paths['auth.json']!)).mode & 0o777).toBe(0o600)
      expect((await stat(join(directory, 'owner.json'))).mode & 0o777).toBe(0o600)
    }
    expect(JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8'))).toEqual({
      owner: 'dsh-agent-runtime-launcher-v1',
      pid: process.pid,
      files: ['auth.json', 'binary'],
    })

    await material.cleanup()
    await material.cleanup()
    await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['', '.', '..', 'owner.json', 'nested/file', 'name\0suffix'])(
    'rejects an unsafe filename before creating a launch directory: %s',
    async (name) => {
      const root = await temporaryRoot()
      const owner = new RuntimeTemporaryMaterialOwner(root)
      await owner.initialize()

      await expect(owner.create([{ name, content: 'secret' }])).rejects.toThrow('invalid')
      expect(await readdir(root)).toEqual([])
    },
  )

  it('rejects duplicate filenames before creating a launch directory', async () => {
    const root = await temporaryRoot()
    const owner = new RuntimeTemporaryMaterialOwner(root)
    await owner.initialize()

    await expect(owner.create([
      { name: 'same', content: 'first' },
      { name: 'same', content: 'second' },
    ])).rejects.toThrow('duplicate')
    expect(await readdir(root)).toEqual([])
  })

  it('scavenges only stale directories bearing its valid owner marker', async () => {
    const root = await temporaryRoot()
    const stale = join(root, 'run-stale')
    const live = join(root, 'run-live')
    const foreign = join(root, 'run-foreign')
    const ordinary = join(root, 'ordinary')
    await Promise.all([stale, live, foreign, ordinary].map(path => mkdir(path, { recursive: true })))
    await writeFile(join(stale, 'owner.json'), JSON.stringify({
      owner: 'dsh-agent-runtime-launcher-v1',
      pid: 101,
      files: ['auth'],
    }))
    await writeFile(join(live, 'owner.json'), JSON.stringify({
      owner: 'dsh-agent-runtime-launcher-v1',
      pid: 202,
      files: [],
    }))
    await writeFile(join(foreign, 'owner.json'), JSON.stringify({
      owner: 'another-owner',
      pid: 101,
      files: [],
    }))

    const owner = new RuntimeTemporaryMaterialOwner(root, pid => pid === 202)
    await owner.initialize()

    await expect(lstat(stale)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(live)).resolves.toMatchObject({})
    await expect(lstat(foreign)).resolves.toMatchObject({})
    await expect(lstat(ordinary)).resolves.toMatchObject({})
  })

  it('ignores malformed, incomplete, live, and non-directory run entries', async () => {
    const root = await temporaryRoot()
    const live = join(root, 'run-live')
    const malformed = join(root, 'run-malformed')
    const missing = join(root, 'run-missing')
    const metadataDirectory = join(root, 'run-metadata-directory')
    const invalid = join(root, 'run-invalid')
    await Promise.all([live, malformed, missing, metadataDirectory, invalid]
      .map(path => mkdir(path, { recursive: true })))
    await writeFile(join(live, 'owner.json'), JSON.stringify({
      owner: 'dsh-agent-runtime-launcher-v1',
      pid: process.pid,
      files: [],
    }))
    await writeFile(join(malformed, 'owner.json'), '{')
    await mkdir(join(metadataDirectory, 'owner.json'))
    await writeFile(join(invalid, 'owner.json'), 'null')
    await writeFile(join(root, 'run-file'), 'ordinary file')

    const owner = new RuntimeTemporaryMaterialOwner(root)
    await owner.initialize()

    for (const path of [live, malformed, missing, metadataDirectory, invalid, join(root, 'run-file')]) {
      await expect(lstat(path)).resolves.toMatchObject({})
    }
  })

  it('treats a non-ESRCH process probe failure as potentially live', async () => {
    const root = await temporaryRoot()
    const candidate = join(root, 'run-probe-failure')
    await mkdir(candidate)
    await writeFile(join(candidate, 'owner.json'), JSON.stringify({
      owner: 'dsh-agent-runtime-launcher-v1',
      pid: 424_242,
      files: [],
    }))
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EPERM' })
    })
    try {
      await new RuntimeTemporaryMaterialOwner(root).initialize()
      await expect(lstat(candidate)).resolves.toMatchObject({})
    } finally {
      kill.mockRestore()
    }
  })

  it('uses the default process probe to scavenge an absent owner', async () => {
    const root = await temporaryRoot()
    const candidate = join(root, 'run-absent')
    await mkdir(candidate)
    await writeFile(join(candidate, 'owner.json'), JSON.stringify({
      owner: 'dsh-agent-runtime-launcher-v1',
      pid: 424_242,
      files: [],
    }))
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('absent'), { code: 'ESRCH' })
    })
    try {
      await new RuntimeTemporaryMaterialOwner(root).initialize()
      await expect(lstat(candidate)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      kill.mockRestore()
    }
  })

  it('unlinks run-shaped symlinks without following them', async () => {
    const root = await temporaryRoot()
    const target = await temporaryRoot()
    await writeFile(join(target, 'keep'), 'present')
    const link = join(root, 'run-linked')
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')

    const owner = new RuntimeTemporaryMaterialOwner(root)
    await owner.initialize()

    await expect(lstat(link)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(target, 'keep'), 'utf8')).resolves.toBe('present')
  })

  it('unlinks a launch directory replaced by a symlink during cleanup', async () => {
    const root = await temporaryRoot()
    const target = await temporaryRoot()
    await writeFile(join(target, 'keep'), 'present')
    const owner = new RuntimeTemporaryMaterialOwner(root)
    await owner.initialize()
    const material = await owner.create([{ name: 'auth', content: 'secret' }])
    const directory = dirname(material.paths.auth!)
    await rm(directory, { recursive: true })
    await symlink(target, directory, process.platform === 'win32' ? 'junction' : 'dir')

    await material.cleanup()

    await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(target, 'keep'), 'utf8')).resolves.toBe('present')
  })

  it('rejects cleanup when the owned directory was replaced by a regular file', async () => {
    const root = await temporaryRoot()
    const owner = new RuntimeTemporaryMaterialOwner(root)
    await owner.initialize()
    const material = await owner.create([{ name: 'auth', content: 'secret' }])
    const directory = dirname(material.paths.auth!)
    const retained = `${directory}-old`
    await rename(directory, retained)
    await writeFile(directory, 'replacement')

    await expect(material.cleanup()).rejects.toThrow('is not a directory')
    await rm(directory)
    await rename(retained, directory)
    await material.cleanup()
  })
})
