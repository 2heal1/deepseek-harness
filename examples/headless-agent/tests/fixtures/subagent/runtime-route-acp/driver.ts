#!/usr/bin/env node
/** Exercise the optional ACP runtime Bundle through a one-shot subagent route. */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { boot, loadOverlayPatches, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'

const configPath = process.argv[2]
const bundlePatchPath = process.argv[3]
if (configPath === undefined || bundlePatchPath === undefined) {
  throw new Error('runtime-route-acp fixture requires config and Bundle patch paths')
}

const ctx = await boot(
  'runtime-route-acp-fixture',
  resolveConfigPath(configPath, undefined),
  loadOverlayPatches('runtime-route-acp-fixture', bundlePatchPath),
)

const lifecycle: string[] = []
ctx.on('subagent/start', (info) => { lifecycle.push(`start:${info.provider}`) })
ctx.on('subagent/end', (info) => { lifecycle.push(`end:${info.stopReason}`) })

let summary: object
try {
  const parent = {
    id: SessionId('parent'),
    options: {},
    session: {
      id: SessionId('parent'),
      header: { cwd: process.cwd(), delegationDepth: 0 },
    },
  } as unknown as Agent
  const run = await ctx.subagents.start('acp-child', {
    prompt: [{ type: 'text', text: 'complete the child task' }],
    parent,
    signal: new AbortController().signal,
  })
  const result = await run.result
  await run.dispose()
  const marker = JSON.parse(
    await readFile(join(process.cwd(), '.acp-child.json'), 'utf8'),
  ) as {
    argv: string[]
    cwd: string
    childCredential?: string
    parentCredential: string | null
  }
  summary = {
    runtimeProviders: ctx.agentRuntimes.listProviders().map(provider => provider.id),
    routeProviders: ctx.subagents.list(),
    toolRegistered: ctx.tools.get('delegate_to_acp_child') !== undefined,
    result,
    lifecycle,
    launch: {
      argv: marker.argv,
      parentWorkspace: marker.cwd === process.cwd(),
      childCredentialPresent: marker.childCredential === process.env.CHILD_RUNTIME_KEY,
      parentCredentialAbsent: marker.parentCredential === null,
    },
    temporaryEntries: await readdir(join(process.cwd(), '.runtime-launches')),
  }
} finally {
  await ctx.fiber.dispose()
}

process.stdout.write(`${JSON.stringify(summary!, null, 2)}\n`)
