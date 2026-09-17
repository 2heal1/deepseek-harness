#!/usr/bin/env node
/** Exercise the complete V1 external-main to MCP to external-child composition. */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { boot, loadOverlayPatches, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

const configPath = process.argv[2]
const codexPatchPath = process.argv[3]
const acpPatchPath = process.argv[4]
if (configPath === undefined || codexPatchPath === undefined || acpPatchPath === undefined) {
  throw new Error('runtime-chain fixture requires config, Codex patch, and ACP patch paths')
}

const ctx = await boot(
  'runtime-chain-fixture',
  resolveConfigPath(configPath, undefined),
  [
    ...loadOverlayPatches('runtime-chain-fixture', codexPatchPath),
    ...loadOverlayPatches('runtime-chain-fixture', acpPatchPath),
  ],
)

let summary: object
try {
  const handle = await ctx.agents.create({
    sessionId: SessionId('runtime-chain'),
    meta: { cwd: process.cwd() },
    agentOptions: { runtimeProfile: 'codex-main' },
  })
  try {
    const receipt = handle.agent.submit(createUserMessage({
      content: [{ type: 'text', text: 'delegate this task to the configured child' }],
      source: { kind: 'user' },
    }))
    const started = await receipt.started
    const settled = await receipt.settled
    await handle.agent.whenIdle()

    const mainLaunch = JSON.parse(
      await readFile(join(process.cwd(), '.runtime-main.json'), 'utf8'),
    ) as {
      environment: Record<string, string>
      gatewayToken: string
      listedTools: string[]
      childResult: unknown
    }
    const childLaunch = JSON.parse(
      await readFile(join(process.cwd(), '.runtime-child.json'), 'utf8'),
    ) as {
      environment: Record<string, string>
      childCredential: string
    }
    const mainAllowed = new Set([
      'DSH_HARNESS_MCP_TOKEN',
      'DSH_RUNTIME_MAIN_MARKER',
      'SystemRoot',
      'ComSpec',
      'PATHEXT',
      '__CF_USER_TEXT_ENCODING',
    ])
    const childAllowed = new Set([
      'CHILD_PROVIDER_API_KEY',
      'DSH_RUNTIME_CHILD_MARKER',
      'SystemRoot',
      'ComSpec',
      'PATHEXT',
      '__CF_USER_TEXT_ENCODING',
    ])
    const events = handle.agent.session.events
    const knownSecrets = [
      mainLaunch.gatewayToken,
      childLaunch.childCredential,
      process.env.PARENT_SECRET_TOKEN ?? '',
    ].filter(value => value.length > 0)
    const harnessOwned = JSON.stringify({
      header: handle.agent.session.header,
      events,
      settled,
    })
    const canaryFree = knownSecrets.every(secret => !harnessOwned.includes(secret))
    if (!canaryFree) throw new Error('runtime-chain fixture found a secret in Harness-owned state')

    summary = {
      runtimeProviders: ctx.agentRuntimes.listProviders().map(provider => provider.id),
      routeProviders: ctx.subagents.list(),
      listedTools: mainLaunch.listedTools,
      childResult: mainLaunch.childResult,
      receipt: {
        started,
        settled,
      },
      assistantDeltas: events.flatMap(event =>
        event.type === 'assistant/chunk' && event.data.chunk.type === 'text-delta'
          ? [event.data.chunk.text]
          : []),
      assistantMessages: events.flatMap(event =>
        event.type === 'assistant/message'
          ? event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : [])
          : []),
      runtimeTools: events.flatMap<Record<string, unknown>>(event =>
        event.type === 'agent/runtime/tool-call'
          ? [{ type: event.type, name: event.data.name }]
          : event.type === 'agent/runtime/tool-result'
            ? [{ type: event.type, content: event.data.content, isError: event.data.isError }]
            : []),
      environmentIsolation: {
        mainExact: Object.keys(mainLaunch.environment).every(name => mainAllowed.has(name)),
        mainUnexpected: Object.keys(mainLaunch.environment).filter(name => !mainAllowed.has(name)).sort(),
        mainHasGatewayToken: mainLaunch.environment.DSH_HARNESS_MCP_TOKEN === mainLaunch.gatewayToken,
        mainLacksChildCredential: mainLaunch.environment.CHILD_PROVIDER_API_KEY === undefined,
        mainLacksAmbientSecret: mainLaunch.environment.PARENT_SECRET_TOKEN === undefined,
        childExact: Object.keys(childLaunch.environment).every(name => childAllowed.has(name)),
        childUnexpected: Object.keys(childLaunch.environment).filter(name => !childAllowed.has(name)).sort(),
        childHasOwnCredential: childLaunch.environment.CHILD_PROVIDER_API_KEY === childLaunch.childCredential,
        childLacksGatewayToken: childLaunch.environment.DSH_HARNESS_MCP_TOKEN === undefined,
        childLacksAmbientSecret: childLaunch.environment.PARENT_SECRET_TOKEN === undefined,
      },
      canaryFree,
      eventTypes: events.map(event => event.type),
      finalStatus: handle.agent.status,
    }
  } finally {
    await handle.dispose()
  }
} finally {
  await ctx.fiber.dispose()
}

process.stdout.write(`${JSON.stringify(summary!, null, 2)}\n`)
