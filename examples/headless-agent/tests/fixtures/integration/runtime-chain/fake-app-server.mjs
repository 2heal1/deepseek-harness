import { writeFileSync } from 'node:fs'

if (!process.argv.slice(2).includes('app-server') || !process.argv.slice(2).includes('--stdio')) {
  throw new Error(`unexpected Codex argv: ${JSON.stringify(process.argv.slice(2))}`)
}

const config = Object.fromEntries(process.argv.slice(2).flatMap((value, index, argv) =>
  value === '-c' && argv[index + 1]?.includes('=')
    ? [argv[index + 1].split(/=(.*)/s).slice(0, 2)]
    : []))
const gatewayUrl = JSON.parse(config['mcp_servers.deepseek_harness.url'])
const tokenEnvironment = JSON.parse(
  config['mcp_servers.deepseek_harness.bearer_token_env_var'],
)
const gatewayToken = process.env[tokenEnvironment]
const marker = process.env.DSH_RUNTIME_MAIN_MARKER
if (typeof gatewayToken !== 'string' || typeof marker !== 'string') {
  throw new Error('runtime-chain main fixture is missing its gateway token or marker')
}

let buffer = ''
const send = (...frames) => {
  process.stdout.write(`${frames.map(frame => JSON.stringify(frame)).join('\n')}\n`)
}
const rpc = async (id, method, params) => {
  const response = await fetch(gatewayUrl, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${gatewayToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      ...(params === undefined ? {} : { params }),
    }),
  })
  return response.json()
}

process.stdin.setEncoding('utf8')
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
            id: 'runtime-chain-main',
            ephemeral: true,
            canAcceptDirectInput: true,
          },
        },
      })
      continue
    }
    if (frame.method !== 'turn/start') continue

    const turnId = 'runtime-chain-turn'
    send(
      { id: frame.id, result: { turn: { id: turnId } } },
      {
        method: 'turn/started',
        params: { threadId: 'runtime-chain-main', turn: { id: turnId } },
      },
    )
    void (async () => {
      const listed = await rpc(1, 'tools/list')
      const called = await rpc(2, 'tools/call', {
        name: 'delegate_to_acp_child',
        arguments: {
          description: 'Verify runtime chain',
          prompt: 'return the child runtime canary',
        },
      })
      const listedTools = listed.result.tools.map(tool => tool.name)
      const childResult = called.result
      const childText = childResult.content.map(block => block.text ?? '').join('')
      writeFileSync(marker, JSON.stringify({
        environment: process.env,
        gatewayToken,
        listedTools,
        childResult,
      }))
      const split = Math.floor(gatewayToken.length / 2)
      send(
        {
          method: 'item/agentMessage/delta',
          params: {
            threadId: 'runtime-chain-main',
            turnId,
            delta: `MAIN_RESULT=${childText}; TOKEN=${gatewayToken.slice(0, split)}`,
          },
        },
        {
          method: 'item/agentMessage/delta',
          params: {
            threadId: 'runtime-chain-main',
            turnId,
            delta: gatewayToken.slice(split),
          },
        },
        {
          method: 'item/completed',
          params: {
            threadId: 'runtime-chain-main',
            turnId,
            item: {
              type: 'agentMessage',
              text: `MAIN_RESULT=${childText}; TOKEN=${gatewayToken}`,
              phase: 'final_answer',
            },
          },
        },
        {
          method: 'turn/completed',
          params: {
            threadId: 'runtime-chain-main',
            turn: { id: turnId, status: 'completed', error: null },
          },
        },
      )
    })()
  }
})
process.stdin.on('end', () => process.exit(0))
setInterval(() => {}, 1_000)
