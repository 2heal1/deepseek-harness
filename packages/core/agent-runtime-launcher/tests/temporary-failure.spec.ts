import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { RuntimeTemporaryMaterialOwner } from '@deepseek-ai/dsh-agent-runtime-launcher'
import { afterEach, describe, expect, it, vi } from 'vitest'

const failSecondOpen = vi.hoisted(() => ({ value: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (failSecondOpen.value && basename(String(args[0])) === 'second') {
        throw Object.assign(new Error('simulated file creation failure'), { code: 'EIO' })
      }
      return await actual.open(...args)
    },
  }
})

const roots: string[] = []

afterEach(async () => {
  failSecondOpen.value = false
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('RuntimeTemporaryMaterialOwner creation rollback', () => {
  it('removes partially created launch material when a file cannot be opened', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-material-failure-'))
    roots.push(root)
    const owner = new RuntimeTemporaryMaterialOwner(root)
    await owner.initialize()
    failSecondOpen.value = true

    await expect(owner.create([
      { name: 'first', content: 'created' },
      { name: 'second', content: 'fails' },
    ])).rejects.toThrow('simulated file creation failure')
    expect(await readdir(root)).toEqual([])
  })
})
