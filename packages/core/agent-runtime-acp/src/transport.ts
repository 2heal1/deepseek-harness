/**
 * Bounded newline-delimited JSON transport for ACP stdio.
 *
 * @module @deepseek-ai/dsh-agent-runtime-acp/transport
 */

import type { Readable, Writable } from 'node:stream'
import type { AnyMessage, Stream } from '@agentclientprotocol/sdk'

const INVALID_FRAME_MESSAGE = 'ACP input contains an invalid JSON-RPC frame'

/** Sanitized terminal failure from ACP input framing or decoding. */
export class AcpTransportError extends Error {
  /**
   * @param message - bounded diagnostic that contains no peer-controlled frame data.
   */
  constructor(message: string) {
    super(message)
    this.name = 'AcpTransportError'
  }
}

function invalidFrame(): AcpTransportError {
  return new AcpTransportError(INVALID_FRAME_MESSAGE)
}

function parseFrame(bytes: Buffer): AnyMessage | undefined {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim()
  } catch {
    throw invalidFrame()
  }
  if (text.length === 0) return undefined

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw invalidFrame()
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidFrame()
  }
  const frame = value as Record<string, unknown>
  const validId = frame.id === null || typeof frame.id === 'string' || typeof frame.id === 'number'
  const hasMethod = typeof frame.method === 'string'
  const hasResult = Object.hasOwn(frame, 'result')
  const hasError = frame.error !== null && typeof frame.error === 'object' && !Array.isArray(frame.error)
  if (frame.jsonrpc !== '2.0'
    || (!hasMethod && !validId)
    || (hasMethod && Object.hasOwn(frame, 'id') && !validId)
    || (!hasMethod && hasResult === hasError)) {
    throw invalidFrame()
  }
  return frame as AnyMessage
}

async function write(output: Writable, bytes: Uint8Array): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    output.write(bytes, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

/**
 * Adapt caller-owned Node streams to the ACP SDK while rejecting malformed or
 * oversized input without logging peer-controlled frame contents.
 *
 * @param output - child stdin used for outbound ACP messages.
 * @param input - child stdout carrying inbound ACP messages.
 * @param maxFrameBytes - maximum UTF-8 bytes accepted before one newline.
 * @returns the ACP SDK message stream.
 */
export function acpNdJsonStream(
  output: Writable,
  input: Readable,
  maxFrameBytes: number,
): Stream {
  const iterator = input[Symbol.asyncIterator]()
  let fragments: Buffer[] = []
  let length = 0
  let chunk: Buffer | undefined
  let offset = 0

  const append = (bytes: Buffer): void => {
    if (length + bytes.length > maxFrameBytes) {
      throw new AcpTransportError(`ACP input frame exceeds ${maxFrameBytes} bytes`)
    }
    if (bytes.length > 0) fragments.push(bytes)
    length += bytes.length
  }

  const emit = (): AnyMessage | undefined => {
    const message = parseFrame(Buffer.concat(fragments, length))
    fragments = []
    length = 0
    return message
  }

  const nextMessage = async (): Promise<AnyMessage | undefined> => {
    for (;;) {
      if (chunk !== undefined) {
        const newline = chunk.indexOf(0x0A, offset)
        if (newline < 0) {
          append(chunk.subarray(offset))
          chunk = undefined
          offset = 0
        } else {
          append(chunk.subarray(offset, newline))
          offset = newline + 1
          if (offset === chunk.length) {
            chunk = undefined
            offset = 0
          }
          const message = emit()
          if (message !== undefined) return message
          continue
        }
      }

      const next = await iterator.next()
      if (next.done) return length === 0 ? undefined : emit()
      chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value as Uint8Array)
    }
  }

  const readable = new ReadableStream<AnyMessage>({
    async pull(controller) {
      try {
        const message = await nextMessage()
        if (message === undefined) controller.close()
        else controller.enqueue(message)
      } catch (error: unknown) {
        try {
          await iterator.return?.()
        } catch {
          // The protocol failure remains authoritative; Launcher disposal owns the process and pipes.
        }
        controller.error(error)
      }
    },
    async cancel() {
      await iterator.return?.()
    },
  })

  const writable = new WritableStream<AnyMessage>({
    async write(message) {
      await write(output, new TextEncoder().encode(`${JSON.stringify(message)}\n`))
    },
  })

  return { readable, writable }
}
