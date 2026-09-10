import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk'

const scenario = process.env.MOCK_SCENARIO ?? 'success'
const exitMarker = process.env.MOCK_EXIT_MARKER
const promptMarker = process.env.MOCK_PROMPT_MARKER
const cancelMarker = process.env.MOCK_CANCEL_MARKER
let settlePrompt

process.on('exit', () => {
  if (exitMarker !== undefined) writeFileSync(exitMarker, 'exited')
})

new AgentSideConnection(
  connection => ({
    async initialize() {
      if (scenario === 'startup-failure') throw new Error('private startup failure')
      if (scenario === 'update-during-init') {
        await connection.sessionUpdate({
          sessionId: 'not-created',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'early output' },
          },
        })
      }
      return Promise.resolve({
        protocolVersion: scenario === 'version-mismatch' ? PROTOCOL_VERSION + 1 : PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: {
            image: false,
            audio: false,
            embeddedContext: false,
          },
        },
        ...(scenario === 'no-agent-info'
          ? {}
          : {
            agentInfo: { name: 'Mock ACP Agent', version: '1.2.3' },
          }),
        authMethods: [],
      })
    },
    async newSession() {
      if (scenario === 'slow-start') {
        if (promptMarker !== undefined) writeFileSync(promptMarker, 'starting')
        while (cancelMarker !== undefined && !existsSync(cancelMarker)) {
          await new Promise(resolve => setTimeout(resolve, 5))
        }
      }
      return Promise.resolve({ sessionId: scenario === 'empty-session' ? '' : 'acp-session-1' })
    },
    authenticate() {
      return Promise.resolve()
    },
    async prompt(params) {
      if (promptMarker !== undefined) writeFileSync(promptMarker, 'started')
      if (scenario === 'stderr-flood') process.stderr.write('diagnostic'.repeat(200_000))
      if (scenario === 'malformed-frame') {
        process.stdout.write('{private malformed frame\n')
        return new Promise(() => {})
      }
      if (scenario === 'oversized-frame') {
        process.stdout.write('x'.repeat(513))
        return new Promise(() => {})
      }
      if (scenario === 'eof') process.exit(1)
      if (scenario === 'failure') throw new Error('private protocol failure')
      if (scenario === 'permission') {
        const response = await connection.requestPermission({
          sessionId: params.sessionId,
          toolCall: { toolCallId: 'call-1', title: 'unsafe operation' },
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        })
        if (response.outcome.outcome === 'cancelled') return { stopReason: 'cancelled' }
      }
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'private thought' },
        },
      })
      await connection.sessionUpdate({
        sessionId: scenario === 'wrong-session' ? 'other-session' : params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: scenario === 'non-text-output'
            ? { type: 'image', data: 'AA==', mimeType: 'image/png' }
            : { type: 'text', text: scenario.startsWith('multibyte-output') ? '好' : 'fixture ' },
        },
      })
      if (scenario === 'cancel'
        || scenario === 'crash-cancel'
        || scenario === 'ignore-cancel'
        || scenario === 'timeout') {
        return new Promise(resolve => { settlePrompt = resolve })
      }
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: scenario.startsWith('multibyte-output') ? 'a' : 'answer' },
        },
      })
      if (scenario === 'multibyte-output-overflow') {
        await connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'ignored-after-limit' },
          },
        })
      }
      if (scenario === 'max-tokens') return { stopReason: 'max_tokens' }
      if (scenario === 'refusal') return { stopReason: 'refusal' }
      if (scenario === 'max-turn-requests') return { stopReason: 'max_turn_requests' }
      return { stopReason: 'end_turn' }
    },
    async cancel(params) {
      if (cancelMarker !== undefined) appendFileSync(cancelMarker, params.sessionId)
      if (scenario === 'crash-cancel') process.exit(1)
      if (scenario === 'ignore-cancel' || scenario === 'timeout') return
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'cancelled tail' },
        },
      })
      settlePrompt?.({ stopReason: 'cancelled' })
    },
  }),
  ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin),
  ),
)

if (scenario === 'ignore-cancel' || scenario === 'timeout') {
  setInterval(() => {}, 1_000)
}
