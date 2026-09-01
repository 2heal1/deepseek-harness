/** Launch-scoped known-value redaction for complete values and streamed diagnostics. */

const REDACTION = '[REDACTED]'

function normalizedValues(values: readonly string[]): string[] {
  return [...new Set(values.filter(value => value.length > 0))]
    .sort((left, right) => right.length - left.length)
}

function replaceKnownValues(text: string, values: readonly string[]): string {
  let result = text
  for (const value of values) result = result.split(value).join(REDACTION)
  return result
}

/** Redact known values recursively from Harness-owned diagnostic data. */
export class KnownValueRedactor {
  private readonly values: readonly string[]

  /** @param values - non-empty credential values known for one launch. */
  constructor(values: readonly string[]) {
    this.values = normalizedValues(values)
  }

  /**
   * Redact strings recursively while preserving the input's JSON-compatible structure.
   * @param value - complete diagnostic value.
   * @returns a detached redacted value.
   */
  redact<T>(value: T): T {
    return this.redactValue(value) as T
  }

  /**
   * Create a redactor for one ordered text stream.
   * @returns a stream redactor that retains possible split prefixes.
   */
  stream(): KnownValueStreamRedactor {
    return new KnownValueStreamRedactor(this.values)
  }

  private redactValue(value: unknown): unknown {
    if (typeof value === 'string') return replaceKnownValues(value, this.values)
    if (Array.isArray(value)) return value.map(item => this.redactValue(item))
    if (value === null || typeof value !== 'object') return value
    if (value instanceof Error) {
      return new Error(replaceKnownValues(value.message, this.values), {
        ...(value.cause === undefined ? {} : { cause: this.redactValue(value.cause) }),
      })
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, this.redactValue(entry)]),
    )
  }
}

/** Stateful redactor for values split across arbitrary string chunks. */
export class KnownValueStreamRedactor {
  private readonly values: readonly string[]
  private pending = ''

  /** @param values - non-empty credential values known for one launch. */
  constructor(values: readonly string[]) {
    this.values = normalizedValues(values)
  }

  /**
   * Redact one ordered chunk while retaining a suffix that may begin a known value.
   * @param chunk - next decoded stream chunk.
   * @returns safe text that can be emitted immediately.
   */
  write(chunk: string): string {
    const combined = this.pending + chunk
    let retained = 0
    for (const value of this.values) {
      const maximum = Math.min(value.length - 1, combined.length)
      for (let length = maximum; length > retained; length -= 1) {
        if (combined.endsWith(value.slice(0, length))) {
          retained = length
          break
        }
      }
    }
    const boundary = combined.length - retained
    this.pending = combined.slice(boundary)
    return replaceKnownValues(combined.slice(0, boundary), this.values)
  }

  /**
   * Flush the retained suffix after the source stream closes.
   * @returns the redacted final suffix.
   */
  end(): string {
    const result = replaceKnownValues(this.pending, this.values)
    this.pending = ''
    return result
  }
}
