import { PassThrough } from 'node:stream'
import type { AnyMessage } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'
import { acpNdJsonStream } from '../src/transport.ts'

function fixture(maxFrameBytes = 1_024) {
  const input = new PassThrough()
  const output = new PassThrough()
  const written: Buffer[] = []
  output.on('data', (chunk: Buffer) => { written.push(chunk) })
  const stream = acpNdJsonStream(output, input, maxFrameBytes)
  return {
    input,
    output,
    reader: stream.readable.getReader(),
    writer: stream.writable.getWriter(),
    written,
  }
}

describe('ACP bounded JSONL transport', () => {
  it('reads split multibyte frames at the exact byte limit and skips blank lines', async () => {
    const message = { jsonrpc: '2.0', method: 'fixture', params: { text: '好' } } as const
    const encoded = Buffer.from(JSON.stringify(message))
    const value = fixture(encoded.length)
    value.input.write(Buffer.concat([Buffer.from('\n'), encoded.subarray(0, encoded.length - 2)]))
    value.input.end(Buffer.concat([encoded.subarray(encoded.length - 2), Buffer.from('\n')]))

    await expect(value.reader.read()).resolves.toEqual({ value: message, done: false })
    await expect(value.reader.read()).resolves.toEqual({ value: undefined, done: true })
  })

  it.each([
    ['unterminated', Buffer.from('x'.repeat(9))],
    ['terminated', Buffer.from(`${'x'.repeat(9)}\n`)],
  ] as const)('rejects an oversized %s frame', async (_name, bytes) => {
    const value = fixture(8)
    value.input.end(bytes)
    await expect(value.reader.read()).rejects.toThrow('ACP input frame exceeds 8 bytes')
  })

  it.each([
    ['invalid JSON', '{secret'],
    ['invalid UTF-8', Buffer.from([0xFF])],
    ['scalar JSON', '7'],
    ['wrong version', '{"jsonrpc":"1.0","method":"fixture"}'],
    ['missing method and id', '{"jsonrpc":"2.0","params":{}}'],
    ['invalid request id', '{"jsonrpc":"2.0","id":{},"method":"fixture"}'],
    ['ambiguous response', '{"jsonrpc":"2.0","id":1,"result":{},"error":{}}'],
  ] as const)('rejects %s without reflecting input', async (_name, frame) => {
    const value = fixture()
    value.input.end(typeof frame === 'string' ? `${frame}\n` : Buffer.concat([frame, Buffer.from('\n')]))
    const result = value.reader.read()
    await expect(result).rejects.toThrow('ACP input contains an invalid JSON-RPC frame')
    await expect(result).rejects.not.toThrow('secret')
  })

  it('accepts request, response, error, and EOF-terminated notification frames', async () => {
    const frames: AnyMessage[] = [
      { jsonrpc: '2.0', id: null, method: 'request' },
      { jsonrpc: '2.0', id: 'one', result: null },
      { jsonrpc: '2.0', id: 2, error: { code: -1, message: 'failure' } },
      { jsonrpc: '2.0', method: 'notification' },
    ]
    const value = fixture()
    value.input.end(frames.map(frame => JSON.stringify(frame)).join('\n'))
    for (const frame of frames) {
      await expect(value.reader.read()).resolves.toEqual({ value: frame, done: false })
    }
    await expect(value.reader.read()).resolves.toEqual({ value: undefined, done: true })
  })

  it('accepts a Node input stream configured to emit strings', async () => {
    const value = fixture()
    value.input.setEncoding('utf8')
    value.input.end('{"jsonrpc":"2.0","method":"fixture"}\n')
    await expect(value.reader.read()).resolves.toEqual({
      value: { jsonrpc: '2.0', method: 'fixture' },
      done: false,
    })
  })

  it('propagates input and output stream failures', async () => {
    const input = fixture()
    input.input.destroy(new Error('input failed'))
    await expect(input.reader.read()).rejects.toThrow('input failed')

    const output = fixture()
    output.output.on('error', () => {})
    output.output.destroy(new Error('output failed'))
    await expect(output.writer.write({
      jsonrpc: '2.0',
      method: 'fixture',
    })).rejects.toThrow()
  })

  it('serializes outbound ACP messages as one JSONL frame', async () => {
    const value = fixture()
    const message: AnyMessage = { jsonrpc: '2.0', method: 'fixture', params: { value: true } }
    await value.writer.write(message)
    expect(Buffer.concat(value.written).toString('utf8')).toBe(`${JSON.stringify(message)}\n`)
    value.input.end()
  })

  it('accepts ACP reader cancellation', async () => {
    const value = fixture()
    await expect(value.reader.cancel()).resolves.toBeUndefined()
  })
})
