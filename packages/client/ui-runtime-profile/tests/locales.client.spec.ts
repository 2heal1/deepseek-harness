/** Runtime Profile copy keeps the English and Chinese key sets aligned. */

import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'

describe('Runtime Profile locales', () => {
  it('provides non-empty copy for the same keys in both languages', () => {
    expect(Object.keys(zh)).toEqual(Object.keys(en))
    for (const value of [...Object.values(en), ...Object.values(zh)]) {
      expect(value.length).toBeGreaterThan(0)
    }
  })
})
