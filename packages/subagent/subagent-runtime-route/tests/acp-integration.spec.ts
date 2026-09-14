import { mkdtemp, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentRuntimeRegistry from '@deepseek-ai/dsh-agent-runtime'
import * as AcpRuntime from '@deepseek-ai/dsh-agent-runtime-acp'
import AgentRuntimeLauncher from '@deepseek-ai/dsh-agent-runtime-launcher'
import AgentRuntimeProfiles from '@deepseek-ai/dsh-agent-runtime-profile'
import CredentialProvider, {
  credentialRef,
  type CredentialInfo,
  type CredentialRef,
  type ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import AgentRuntimeSubagentRoutes from '@deepseek-ai/dsh-subagent-runtime-route'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'

const childScript = fileURLToPath(new URL(
  '../../../../examples/headless-agent/tests/fixtures/subagent/runtime-route-acp/fake-acp.mjs',
  import.meta.url,
))
const roots: string[] = []

class MemoryCredentials extends CredentialProvider {
  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return Promise.resolve(ref === credentialRef('CHILD_RUNTIME_KEY')
      ? { value: 'child-only-secret', source: 'memory' }
      : undefined)
  }

  describe(ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({
      configured: ref === credentialRef('CHILD_RUNTIME_KEY'),
      source: 'memory',
      writable: false,
    })
  }

  set(): Promise<void> {
    return Promise.reject(new Error('read-only'))
  }

  unset(): Promise<void> {
    return Promise.reject(new Error('read-only'))
  }
}

afterEach(async () => {
  delete process.env.PARENT_SECRET_TOKEN
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Runtime Profile-backed ACP child', () => {
  it('uses the parent workspace, exact child credentials, Driver argv, and quiescent cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-route-acp-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    const temporaryRoot = join(root, 'launches')
    const marker = join(root, 'child.json')
    await mkdir(workspace)
    const canonicalWorkspace = await realpath(workspace)
    process.env.PARENT_SECRET_TOKEN = 'must-not-reach-child'

    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(MemoryCredentials)
    await ctx.plugin(AgentRuntimeProfiles, {
      defaultMainProfile: 'acp-child',
      profiles: {
        'acp-child': {
          provider: 'acp',
          launch: {
            executable: process.execPath,
            args: [childScript],
            resolution: 'absolute',
            cwdPolicy: 'parent-workspace',
            env: {
              DSH_ACP_CHILD_MARKER: marker,
            },
          },
          permissions: {
            policy: { sandbox: 'workspace-write' },
            enforcement: 'best-effort',
          },
          credentials: {
            env: {
              CHILD_PROVIDER_API_KEY: {
                credentialRef: 'CHILD_RUNTIME_KEY',
              },
            },
          },
          process: {
            startupTimeoutMs: 5_000,
            turnTimeoutMs: 5_000,
            shutdownTimeoutMs: 1_000,
            terminationTimeoutMs: 1_000,
            maxConcurrentRuns: 1,
          },
        },
      },
      subagentRoutes: {
        child: {
          runtimeProfile: 'acp-child',
          maxDepth: 2,
          maxConcurrentRuns: 1,
          toolName: 'delegate_child',
        },
      },
    })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(AgentRuntimeLauncher, { temporaryRoot })
    await ctx.plugin(AgentRuntimeRegistry)
    await ctx.plugin(AcpRuntime, {
      maxFrameBytes: 1_048_576,
      maxOutputBytes: 4_194_304,
      maxStderrBytes: 65_536,
    })
    await ctx.plugin(AgentRuntimeSubagentRoutes, {})

    const lifecycle: string[] = []
    ctx.on('subagent/start', (info) => { lifecycle.push(`start:${info.provider}`) })
    ctx.on('subagent/end', (info) => { lifecycle.push(`end:${info.stopReason}`) })
    const parent = {
      id: SessionId('parent'),
      options: {},
      session: {
        id: SessionId('parent'),
        header: { cwd: workspace, delegationDepth: 0 },
      },
    } as unknown as Agent
    const run = await ctx.subagents.start('child', {
      prompt: [{ type: 'text', text: 'complete the child task' }],
      parent,
      signal: new AbortController().signal,
    })
    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: 'runtime child answer' }],
      stopReason: 'completed',
    })
    await run.dispose()

    const child = JSON.parse(await readFile(marker, 'utf8')) as Record<string, unknown>
    expect(child).toMatchObject({
      argv: ['acp', 'serve'],
      childCredential: 'child-only-secret',
      parentCredential: null,
    })
    if (typeof child.cwd !== 'string') throw new TypeError('child cwd must be a string')
    await expect(realpath(child.cwd)).resolves.toBe(canonicalWorkspace)
    expect(lifecycle).toEqual(['start:child', 'end:completed'])
    await expect(readdir(temporaryRoot)).resolves.toEqual([])
    await ctx.fiber.dispose()
  })
})
