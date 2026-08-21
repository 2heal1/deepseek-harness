import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AgentSideConnection,
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
  type Client,
  type PromptResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'

const fixtureDir = fileURLToPath(new URL('./fixtures/protocol-v1-sdk-0.25.1/', import.meta.url))
const fixtureNames = ['one-shot', 'cancel', 'error', 'shutdown'] as const
const require = createRequire(import.meta.url)

type Direction = 'client->agent' | 'agent->client'

interface FrameEvent {
  direction: Direction
  frame: unknown
}

interface EofEvent {
  direction: Direction
  eof: true
}

type ProtocolEvent = FrameEvent | EofEvent

interface RecordingPipe {
  input: ReadableStream<Uint8Array>
  output: WritableStream<Uint8Array>
  setRecording(enabled: boolean): void
}

interface ProtocolHarness {
  agent: AgentSideConnection
  client: ClientSideConnection
  events: ProtocolEvent[]
  shutdown(record: boolean): Promise<void>
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

async function sdkVersion(): Promise<string> {
  const packagePath = require.resolve('@agentclientprotocol/sdk/package.json')
  const value: unknown = JSON.parse(await readFile(packagePath, 'utf8'))
  if (
    typeof value !== 'object'
    || value === null
    || !('version' in value)
    || typeof value.version !== 'string'
  ) {
    throw new Error('ACP SDK package metadata has no string version')
  }
  return value.version
}

function recordingPipe(direction: Direction, events: ProtocolEvent[]): RecordingPipe {
  const bytes = new TransformStream<Uint8Array, Uint8Array>()
  const forward = bytes.writable.getWriter()
  const decoder = new TextDecoder()
  let recording = true
  let buffered = ''

  const output = new WritableStream<Uint8Array>({
    async write(chunk) {
      buffered += decoder.decode(chunk, { stream: true })
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      if (recording) {
        for (const line of lines) {
          if (line !== '') events.push({ direction, frame: JSON.parse(line) as unknown })
        }
      }
      await forward.write(chunk)
    },
    async close() {
      buffered += decoder.decode()
      if (buffered.trim() !== '') {
        throw new Error(`ACP fixture transport closed with an unterminated frame: ${buffered}`)
      }
      if (recording) events.push({ direction, eof: true })
      await forward.close()
    },
    async abort(reason) {
      await forward.abort(reason)
    },
  })

  return {
    input: bytes.readable,
    output,
    setRecording(enabled) {
      recording = enabled
    },
  }
}

function createHarness(makeAgent: (connection: AgentSideConnection) => Agent): ProtocolHarness {
  const events: ProtocolEvent[] = []
  const clientToAgent = recordingPipe('client->agent', events)
  const agentToClient = recordingPipe('agent->client', events)
  const agent = new AgentSideConnection(
    makeAgent,
    ndJsonStream(agentToClient.output, clientToAgent.input),
  )
  const client = new ClientSideConnection(
    (_agent): Client => ({
      sessionUpdate(_params: SessionNotification): Promise<void> {
        return Promise.resolve()
      },
      requestPermission() {
        return Promise.resolve({ outcome: { outcome: 'cancelled' } })
      },
    }),
    ndJsonStream(clientToAgent.output, agentToClient.input),
  )

  return {
    agent,
    client,
    events,
    async shutdown(record: boolean): Promise<void> {
      clientToAgent.setRecording(record)
      await clientToAgent.output.getWriter().close()
      await agent.closed
      agentToClient.setRecording(record)
      await agentToClient.output.getWriter().close()
      await client.closed
    },
  }
}

function baseAgent(
  prompt: Agent['prompt'],
  cancel: Agent['cancel'] = () => Promise.resolve(),
): Agent {
  return {
    initialize() {
      return Promise.resolve({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: {
            image: false,
            audio: false,
            embeddedContext: false,
          },
        },
        authMethods: [],
      })
    },
    newSession() {
      return Promise.resolve({ sessionId: 'fixture-session' })
    },
    authenticate() {
      return Promise.resolve()
    },
    prompt,
    cancel,
  }
}

async function initialize(client: ClientSideConnection): Promise<string> {
  const initialized = await client.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
  })
  expect(initialized.protocolVersion).toBe(PROTOCOL_VERSION)
  const session = await client.newSession({
    cwd: '/fixture/workspace',
    mcpServers: [],
  })
  return session.sessionId
}

async function captureOneShot(): Promise<ProtocolEvent[]> {
  const harness = createHarness(connection => baseAgent(async (params) => {
    await connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'fixture answer' },
      },
    })
    return { stopReason: 'end_turn' }
  }))
  try {
    const sessionId = await initialize(harness.client)
    await expect(harness.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'fixture task' }],
    })).resolves.toEqual({ stopReason: 'end_turn' })
    return [...harness.events]
  } finally {
    await harness.shutdown(false)
  }
}

async function captureCancel(): Promise<ProtocolEvent[]> {
  let promptStarted!: () => void
  const started = new Promise<void>((resolve) => { promptStarted = resolve })
  let settlePrompt!: (response: PromptResponse) => void
  const pending = new Promise<PromptResponse>((resolve) => { settlePrompt = resolve })
  const harness = createHarness(connection => baseAgent(
    async (params) => {
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'partial answer' },
        },
      })
      promptStarted()
      return pending
    },
    () => {
      settlePrompt({ stopReason: 'cancelled' })
      return Promise.resolve()
    },
  ))
  try {
    const sessionId = await initialize(harness.client)
    const prompt = harness.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'fixture task' }],
    })
    await started
    await harness.client.cancel({ sessionId })
    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' })
    return [...harness.events]
  } finally {
    await harness.shutdown(false)
  }
}

async function captureError(): Promise<ProtocolEvent[]> {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  const harness = createHarness(() => baseAgent(() => {
    throw new Error('fixture prompt failed')
  }))
  try {
    const sessionId = await initialize(harness.client)
    await expect(harness.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'fixture task' }],
    })).rejects.toThrow('Internal error')
    expect(consoleError).toHaveBeenCalled()
    return [...harness.events]
  } finally {
    consoleError.mockRestore()
    await harness.shutdown(false)
  }
}

async function captureShutdown(): Promise<ProtocolEvent[]> {
  const harness = createHarness(() => baseAgent(() => (
    Promise.resolve({ stopReason: 'end_turn' })
  )))
  const sessionId = await initialize(harness.client)
  await expect(harness.client.prompt({
    sessionId,
    prompt: [{ type: 'text', text: 'fixture task' }],
  })).resolves.toEqual({ stopReason: 'end_turn' })
  await harness.shutdown(true)
  return harness.events
}

const captures = {
  'one-shot': captureOneShot,
  cancel: captureCancel,
  error: captureError,
  shutdown: captureShutdown,
} satisfies Record<typeof fixtureNames[number], () => Promise<ProtocolEvent[]>>

describe('ACP protocol spike fixtures', () => {
  it('pins the installed SDK and protocol versions', async () => {
    await expect(readJson(join(fixtureDir, 'manifest.json'))).resolves.toEqual({
      fixtureVersion: 1,
      protocol: 'acp',
      protocolVersion: PROTOCOL_VERSION,
      transport: 'ndjson-stdio',
      sdk: {
        package: '@agentclientprotocol/sdk',
        version: await sdkVersion(),
      },
      scenarios: fixtureNames.map(name => `${name}.json`),
    })
  })

  for (const name of fixtureNames) {
    it(`reproduces the ${name} wire fixture through the official SDK`, async () => {
      await expect(captures[name]()).resolves.toEqual(
        await readJson(join(fixtureDir, `${name}.json`)),
      )
    })
  }
})
