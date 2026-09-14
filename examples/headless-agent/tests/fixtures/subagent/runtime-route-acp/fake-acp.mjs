import { writeFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk'

const marker = process.env.DSH_ACP_CHILD_MARKER

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
        agentInfo: { name: 'Runtime Route Fixture', version: '1.0.0' },
        authMethods: [],
      })
    },
    newSession() {
      return Promise.resolve({ sessionId: 'runtime-route-child' })
    },
    authenticate() {
      return Promise.resolve()
    },
    async prompt(params) {
      if (marker !== undefined) {
        writeFileSync(marker, JSON.stringify({
          argv: process.argv.slice(2),
          cwd: process.cwd(),
          childCredential: process.env.CHILD_PROVIDER_API_KEY,
          parentCredential: process.env.PARENT_SECRET_TOKEN ?? null,
        }))
      }
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'runtime child answer' },
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
