import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

type JsonObject = Record<string, unknown>

const fixtureRoot = new URL('./fixtures/app-server/0.147.0/', import.meta.url)

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as JsonObject
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value
}

function readJson(name: string): JsonObject {
  const path = fileURLToPath(new URL(name, fixtureRoot))
  return object(JSON.parse(readFileSync(path, 'utf8')), name)
}

function steps(fixture: JsonObject): JsonObject[] {
  return array(fixture.steps, `${String(fixture.scenario)} steps`)
    .map((step, index) => object(step, `${String(fixture.scenario)} step ${index}`))
}

function message(step: JsonObject): JsonObject {
  return object(step.message, 'fixture message')
}

function findMethod(
  fixtureSteps: readonly JsonObject[],
  direction: string,
  method: string,
): JsonObject {
  const step = fixtureSteps.find(candidate => (
    candidate.direction === direction
    && candidate.message !== undefined
    && object(candidate.message, 'fixture message').method === method
  ))
  if (step === undefined) throw new Error(`missing ${direction} ${method}`)
  return message(step)
}

function findResponse(
  fixtureSteps: readonly JsonObject[],
  id: number,
): JsonObject {
  const step = fixtureSteps.find(candidate => (
    candidate.direction === 'server-to-client'
    && candidate.message !== undefined
    && object(candidate.message, 'fixture message').id === id
    && object(candidate.message, 'fixture message').method === undefined
  ))
  if (step === undefined) throw new Error(`missing response ${id}`)
  return message(step)
}

function terminalTurn(fixtureSteps: readonly JsonObject[]): JsonObject {
  const completed = findMethod(fixtureSteps, 'server-to-client', 'turn/completed')
  return object(object(completed.params, 'turn/completed params').turn, 'turn/completed turn')
}

describe('Codex App Server 0.147.0 protocol fixtures', () => {
  const manifest = readJson('manifest.json')
  const manifestProduct = object(manifest.product, 'manifest product')
  const packageJson = object(JSON.parse(readFileSync(
    fileURLToPath(new URL('../package.json', import.meta.url)),
    'utf8',
  )), 'package.json')
  const devDependencies = object(packageJson.devDependencies, 'package devDependencies')
  const fixtureNames = ['handshake', 'stream', 'cancel', 'error', 'close'] as const
  const fixtures = Object.fromEntries(
    fixtureNames.map(name => [name, readJson(`${name}.json`)]),
  ) as Record<(typeof fixtureNames)[number], JsonObject>

  it('pins every transcript to the exact official CLI and generated schema version', () => {
    expect(manifest).toMatchObject({
      fixtureFormatVersion: 1,
      protocol: 'codex-app-server',
      transport: 'stdio-jsonl',
      schemaEvidence: {
        command: 'codex app-server generate-json-schema --out <directory>',
        versionSpecific: true,
      },
    })
    expect(manifestProduct).toEqual({
      package: '@openai/codex',
      packageVersion: '0.147.0',
      cliVersionOutput: 'codex-cli 0.147.0',
    })
    expect(devDependencies['@openai/codex']).toBe(manifestProduct.packageVersion)
    expect(object(manifest.scenarios, 'manifest scenarios')).toEqual({
      handshake: 'handshake.json',
      stream: 'stream.json',
      cancel: 'cancel.json',
      error: 'error.json',
      close: 'close.json',
    })
  })

  it('keeps normalized JSONL frames headerless and request ids correlated', () => {
    for (const name of fixtureNames) {
      const fixtureSteps = steps(fixtures[name])
      for (const step of fixtureSteps) {
        if (step.message === undefined) continue
        const frame = message(step)
        expect(frame).not.toHaveProperty('jsonrpc')
        if (
          step.direction === 'client-to-server'
          && typeof frame.id === 'number'
          && typeof frame.method === 'string'
        ) {
          const responseFrame = findResponse(fixtureSteps, frame.id)
          expect(
            responseFrame.result !== undefined || responseFrame.error !== undefined,
          ).toBe(true)
        }
      }
    }
  })

  it('records initialize followed by the initialized acknowledgement', () => {
    const fixtureSteps = steps(fixtures.handshake)
    const initialize = findMethod(fixtureSteps, 'client-to-server', 'initialize')
    const response = findResponse(fixtureSteps, 0)
    const initialized = findMethod(fixtureSteps, 'client-to-server', 'initialized')
    expect(initialize.params).toMatchObject({
      clientInfo: { name: 'deepseek-harness-spike' },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
      },
    })
    expect(object(response.result, 'initialize result')).toMatchObject({
      userAgent: 'deepseek-harness-spike/0.147.0 (<platform>)',
      codexHome: '<codex-home>',
    })
    expect(initialized).not.toHaveProperty('id')
  })

  it('records correlated assistant deltas, committed text, and the completed turn', () => {
    const fixtureSteps = steps(fixtures.stream)
    const threadResponse = object(findResponse(fixtureSteps, 1).result, 'thread/start result')
    const thread = object(threadResponse.thread, 'thread/start thread')
    const turnStart = findMethod(fixtureSteps, 'client-to-server', 'turn/start')
    const turnStarted = findMethod(fixtureSteps, 'server-to-client', 'turn/started')
    const delta = findMethod(fixtureSteps, 'server-to-client', 'item/agentMessage/delta')
    const itemCompleted = findMethod(fixtureSteps, 'server-to-client', 'item/completed')
    const completedItem = object(
      object(itemCompleted.params, 'item/completed params').item,
      'completed item',
    )
    expect(thread).toMatchObject({
      id: '<thread-id>',
      cliVersion: '0.147.0',
      ephemeral: true,
      canAcceptDirectInput: true,
    })
    expect(object(turnStart.params, 'turn/start params').threadId).toBe('<thread-id>')
    expect(object(turnStarted.params, 'turn/started params').threadId).toBe('<thread-id>')
    expect(delta.params).toMatchObject({
      threadId: '<thread-id>',
      turnId: '<turn-id>',
      itemId: '<agent-message-id>',
      delta: 'fixture answer',
    })
    expect(completedItem).toMatchObject({
      type: 'agentMessage',
      id: '<agent-message-id>',
      text: 'fixture answer',
    })
    expect(terminalTurn(fixtureSteps)).toMatchObject({
      id: '<turn-id>',
      status: 'completed',
      error: null,
    })
  })

  it('records interrupt acknowledgement before the interrupted terminal fact', () => {
    const fixtureSteps = steps(fixtures.cancel)
    const interrupt = findMethod(fixtureSteps, 'client-to-server', 'turn/interrupt')
    const interruptIndex = fixtureSteps.findIndex(step => (
      step.message !== undefined && message(step).method === 'turn/interrupt'
    ))
    const responseIndex = fixtureSteps.findIndex(step => (
      step.message !== undefined && message(step).id === 3 && message(step).method === undefined
    ))
    const terminalIndex = fixtureSteps.findIndex(step => (
      step.message !== undefined && message(step).method === 'turn/completed'
    ))
    expect(interrupt.params).toEqual({
      threadId: '<thread-id>',
      turnId: '<turn-id>',
    })
    expect(findResponse(fixtureSteps, 3).result).toEqual({})
    expect(responseIndex).toBeGreaterThan(interruptIndex)
    expect(terminalIndex).toBeGreaterThan(responseIndex)
    expect(terminalTurn(fixtureSteps)).toMatchObject({
      id: '<turn-id>',
      status: 'interrupted',
      error: null,
    })
  })

  it('records one non-retrying error notification and the same failed terminal error', () => {
    const fixtureSteps = steps(fixtures.error)
    const errorNotification = findMethod(fixtureSteps, 'server-to-client', 'error')
    const errorParams = object(errorNotification.params, 'error params')
    const notificationError = object(errorParams.error, 'error notification')
    const terminal = terminalTurn(fixtureSteps)
    expect(errorParams).toMatchObject({
      threadId: '<thread-id>',
      turnId: '<turn-id>',
      willRetry: false,
    })
    expect(notificationError).toMatchObject({ codexErrorInfo: 'other' })
    expect(terminal).toMatchObject({
      id: '<turn-id>',
      status: 'failed',
      error: notificationError,
    })
  })

  it('records stdin closure as EOF and clean process exit without a synthetic turn terminal', () => {
    const fixtureSteps = steps(fixtures.close)
    const lifecycles = fixtureSteps.flatMap(step => (
      typeof step.lifecycle === 'string' ? [step.lifecycle] : []
    ))
    expect(lifecycles).toEqual(['stdin-close', 'stdout-eof', 'process-exit'])
    expect(fixtureSteps.some(step => (
      step.message !== undefined && message(step).method === 'turn/completed'
    ))).toBe(false)
    expect(fixtureSteps.at(-1)).toEqual({
      lifecycle: 'process-exit',
      exitCode: 0,
      signal: null,
    })
  })
})
