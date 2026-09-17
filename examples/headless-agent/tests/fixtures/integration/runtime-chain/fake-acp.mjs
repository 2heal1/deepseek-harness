import { writeFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk'

const marker = process.env.DSH_RUNTIME_CHILD_MARKER
const credential = process.env.CHILD_PROVIDER_API_KEY
if (typeof marker !== 'string' || typeof credential !== 'string') {
  throw new Error('runtime-chain child fixture is missing its credential or marker')
}

new AgentSideConnection(
  connection => ({
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
        agentInfo: { name: 'Runtime Chain Child', version: '1.0.0' },
        authMethods: [],
      })
    },
    newSession() {
      return Promise.resolve({ sessionId: 'runtime-chain-child' })
    },
    authenticate() {
      return Promise.resolve()
    },
    async prompt(params) {
      writeFileSync(marker, JSON.stringify({
        environment: process.env,
        childCredential: credential,
      }))
      const split = Math.floor(credential.length / 2)
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `runtime child ${credential.slice(0, split)}`,
          },
        },
      })
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: credential.slice(split) },
        },
      })
      return { stopReason: 'end_turn' }
    },
  }),
  ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin),
  ),
)
