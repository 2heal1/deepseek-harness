import { writeFileSync } from 'node:fs'
import process from 'node:process'

if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['app-server', '--stdio'])) {
  throw new Error(`unexpected Codex argv: ${JSON.stringify(process.argv.slice(2))}`)
}

let buffer = ''
let turn = 0
let activeTurn

function send(...frames) {
  process.stdout.write(`${frames.map(frame => JSON.stringify(frame)).join('\n')}\n`)
}

process.stdin.setEncoding('utf8')
process.on('exit', () => {
  const marker = process.env.DSH_FIXTURE_EXIT_MARKER
  if (marker !== undefined) writeFileSync(marker, 'exited\n')
})
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const newline = buffer.indexOf('\n')
    if (newline < 0) break
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (line.trim().length === 0) continue
    const frame = JSON.parse(line)

    if (frame.method === 'initialize') {
      send({ id: frame.id, result: { userAgent: 'codex-cli 0.147.0' } })
      continue
    }
    if (frame.method === 'thread/start') {
      send({
        id: frame.id,
        result: {
          thread: {
            id: 'fixture-thread',
            ephemeral: true,
            canAcceptDirectInput: true,
          },
        },
      })
      continue
    }
    if (frame.method === 'turn/start') {
      turn += 1
      activeTurn = `fixture-turn-${turn}`
      send(
        { id: frame.id, result: { turn: { id: activeTurn } } },
        {
          method: 'turn/started',
          params: { threadId: 'fixture-thread', turn: { id: activeTurn } },
        },
      )
      if (turn === 1) {
        setImmediate(() => {
          send(
            {
              method: 'item/agentMessage/delta',
              params: {
                threadId: 'fixture-thread',
                turnId: activeTurn,
                delta: 'EXTERNAL_',
              },
            },
            {
              method: 'item/agentMessage/delta',
              params: {
                threadId: 'fixture-thread',
                turnId: activeTurn,
                delta: 'MAIN_OK',
              },
            },
            {
              method: 'item/completed',
              params: {
                threadId: 'fixture-thread',
                turnId: activeTurn,
                item: {
                  type: 'agentMessage',
                  text: 'EXTERNAL_MAIN_OK',
                  phase: 'final_answer',
                },
              },
            },
            {
              method: 'turn/completed',
              params: {
                threadId: 'fixture-thread',
                turn: {
                  id: activeTurn,
                  status: 'completed',
                  error: null,
                },
              },
            },
          )
        })
      }
      continue
    }
    if (frame.method === 'turn/interrupt' && activeTurn !== undefined) {
      send(
        { id: frame.id, result: {} },
        {
          method: 'turn/completed',
          params: {
            threadId: 'fixture-thread',
            turn: {
              id: activeTurn,
              status: 'interrupted',
              error: null,
            },
          },
        },
      )
    }
  }
})
