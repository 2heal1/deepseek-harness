import {
  KnownValueRedactor,
  KnownValueStreamRedactor,
} from '@deepseek-ai/dsh-agent-runtime-launcher'
import { describe, expect, it } from 'vitest'

describe('KnownValueRedactor', () => {
  it('redacts every known value recursively without mutating the input', () => {
    const input = {
      text: 'alpha-secret and beta-secret',
      nested: ['alpha-secret', 1, null],
    }
    const redactor = new KnownValueRedactor(['', 'beta-secret', 'alpha-secret', 'alpha-secret'])

    expect(redactor.redact(input)).toEqual({
      text: '[REDACTED] and [REDACTED]',
      nested: ['[REDACTED]', 1, null],
    })
    expect(input.text).toBe('alpha-secret and beta-secret')
  })

  it('redacts Error messages and nested causes', () => {
    const redactor = new KnownValueRedactor(['known-secret'])
    const redacted = redactor.redact(new Error('known-secret outer', {
      cause: { detail: 'known-secret inner' },
    }))

    expect(redacted).toBeInstanceOf(Error)
    expect(redacted.message).toBe('[REDACTED] outer')
    expect(redacted.cause).toEqual({ detail: '[REDACTED] inner' })
  })
})

describe('KnownValueStreamRedactor', () => {
  it('withholds prefixes and redacts values split across arbitrary chunks', () => {
    const stream = new KnownValueRedactor(['split-secret']).stream()

    expect(stream.write('before spl')).toBe('before ')
    expect(stream.write('it-sec')).toBe('')
    expect(stream.write('ret after')).toBe('[REDACTED] after')
    expect(stream.end()).toBe('')
  })

  it('handles overlapping known-value prefixes without exposing either value', () => {
    const stream = new KnownValueStreamRedactor(['token', 'token-long'])

    expect(stream.write('token-')).toBe('')
    expect(stream.write('long/token')).toBe('[REDACTED]/')
    expect(stream.end()).toBe('[REDACTED]')
    expect(stream.end()).toBe('')
  })

  it('passes through content when no known values exist', () => {
    const stream = new KnownValueRedactor([]).stream()

    expect(stream.write('plain')).toBe('plain')
    expect(stream.end()).toBe('')
  })
})
