import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentRuntimeRegistry from '@deepseek-ai/dsh-agent-runtime'
import AgentRuntimeLauncher from '@deepseek-ai/dsh-agent-runtime-launcher'
import AgentRuntimeProfiles from '@deepseek-ai/dsh-agent-runtime-profile'
import AgentRuntimeRouter from '@deepseek-ai/dsh-agent-runtime-router'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as AcpRuntime from '../src/index.ts'

const fixturePath = fileURLToPath(new URL('./mock-acp-runtime.mjs', import.meta.url))
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('ACP Provider and Router integration', () => {
  it('persists cancellation tail output before the aborted receipt settles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-acp-router-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    const temporaryRoot = join(root, 'launches')
    const promptMarker = join(workspace, 'prompt')
    const cancelMarker = join(workspace, 'cancel')
    await mkdir(workspace)

    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-agent'",
      "- name: '@deepseek-ai/dsh-agent-runtime-profile'",
      '  config:',
      "    defaultMainProfile: 'acp'",
      '    profiles:',
      '      acp:',
      "        provider: 'acp'",
      '        launch:',
      `          executable: ${JSON.stringify(process.execPath)}`,
      `          args: [${JSON.stringify(fixturePath)}]`,
      "          resolution: 'absolute'",
      `          cwdPolicy: { fixed: ${JSON.stringify(workspace)} }`,
      '          env:',
      "            MOCK_SCENARIO: 'cancel'",
      `            MOCK_PROMPT_MARKER: ${JSON.stringify(promptMarker)}`,
      `            MOCK_CANCEL_MARKER: ${JSON.stringify(cancelMarker)}`,
      '        permissions:',
      "          policy: { sandbox: 'workspace-write' }",
      "          enforcement: 'best-effort'",
      '        process:',
      '          startupTimeoutMs: 1000',
      '          turnTimeoutMs: 1000',
      '          shutdownTimeoutMs: 100',
      '          terminationTimeoutMs: 1000',
      '          maxConcurrentRuns: 1',
      "- name: '@deepseek-ai/dsh-subprocess-local'",
      "- name: '@deepseek-ai/dsh-agent-runtime-launcher'",
      '  config:',
      `    temporaryRoot: ${JSON.stringify(temporaryRoot)}`,
      "- name: '@deepseek-ai/dsh-agent-runtime'",
      "- name: '@deepseek-ai/dsh-agent-runtime-acp'",
      '  config:',
      '    maxFrameBytes: 1048576',
      '    maxOutputBytes: 4194304',
      '    maxStderrBytes: 65536',
      "- name: '@deepseek-ai/dsh-agent-runtime-router'",
      '',
    ].join('\n'))

    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-llm', LlmRuntime],
      ['@deepseek-ai/dsh-session', SessionStore],
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-agent', AgentRegistry],
      ['@deepseek-ai/dsh-agent-runtime-profile', AgentRuntimeProfiles],
      ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
      ['@deepseek-ai/dsh-agent-runtime-launcher', AgentRuntimeLauncher],
      ['@deepseek-ai/dsh-agent-runtime', AgentRuntimeRegistry],
      ['@deepseek-ai/dsh-agent-runtime-acp', AcpRuntime],
      ['@deepseek-ai/dsh-agent-runtime-router', AgentRuntimeRouter],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await ctx.loader.await()

    try {
      const handle = await ctx.agents.create({
        sessionId: SessionId('router-acp'),
        meta: { cwd: workspace },
      })
      const receipt = handle.agent.submit(createUserMessage({
        content: [{ type: 'text', text: 'fixture task' }],
        source: { kind: 'user' },
      }))
      await receipt.started
      await vi.waitFor(async () => {
        await expect(access(promptMarker)).resolves.toBeUndefined()
      })
      const cause = { kind: 'user' } as const
      expect(handle.agent.cancelSubmission(receipt.id, cause)).toBe(true)
      await expect(receipt.settled).resolves.toMatchObject({
        kind: 'settled',
        reason: { kind: 'aborted', reason: cause },
      })
      expect(handle.agent.session.events.find(event =>
        event.type === 'assistant/chunk'
        && event.data.chunk.type === 'text-delta'
        && event.data.chunk.text === 'cancelled tail',
      )).toMatchObject({
        type: 'assistant/chunk',
        data: { chunk: { type: 'text-delta', text: 'cancelled tail' } },
      })
      expect(handle.agent.session.events.find(event =>
        event.type === 'assistant/message',
      )).toMatchObject({
        type: 'assistant/message',
        data: {
          message: {
            content: [{ type: 'text', text: 'fixture cancelled tail' }],
          },
        },
      })
      await expect(readFile(cancelMarker, 'utf8')).resolves.toBe('acp-session-1')
      await handle.dispose()
      await expect(readdir(temporaryRoot)).resolves.toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
