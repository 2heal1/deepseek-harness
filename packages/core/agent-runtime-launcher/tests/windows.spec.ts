import {
  assertSupportedWindowsExecutable,
  isWindowsCommandScript,
  windowsCommandScriptArgv,
} from '@deepseek-ai/dsh-agent-runtime-launcher'
import { describe, expect, it } from 'vitest'

describe('Windows runtime launcher', () => {
  it('classifies command scripts case-insensitively', () => {
    expect(isWindowsCommandScript(String.raw`C:\runtime\agent.CMD`)).toBe(true)
    expect(isWindowsCommandScript(String.raw`C:\runtime\agent.bat`)).toBe(true)
    expect(isWindowsCommandScript(String.raw`C:\runtime\agent.exe`)).toBe(false)
  })

  it.each([
    String.raw`C:\runtime\agent.com`,
    String.raw`C:\runtime\agent.EXE`,
    String.raw`C:\runtime\agent.bat`,
    String.raw`C:\runtime\agent.CMD`,
  ])('accepts a supported executable extension: %s', (path) => {
    expect(() => {
      assertSupportedWindowsExecutable(path)
    }).not.toThrow()
  })

  it('rejects executable types that cannot be launched safely', () => {
    expect(() => {
      assertSupportedWindowsExecutable(String.raw`C:\runtime\agent`)
    })
      .toThrow('does not support Windows executable extension ""')
    expect(() => {
      assertSupportedWindowsExecutable(String.raw`C:\runtime\agent.ps1`)
    })
      .toThrow('does not support Windows executable extension ".ps1"')
  })

  it('encodes the sole supported ComSpec command-script invocation', () => {
    expect(windowsCommandScriptArgv(
      String.raw`C:\Windows\System32\cmd.exe`,
      String.raw`C:\Program Files\Runtime\agent.cmd`,
      ['serve now', 'say"hello'],
    )).toEqual([
      String.raw`C:\Windows\System32\cmd.exe`,
      '/d',
      '/s',
      '/c',
      String.raw`""C:\Program Files\Runtime\agent.cmd" "serve now" "say""hello""`,
    ])
  })

  it.each(['nul\0byte', 'line\rbreak', 'line\nbreak', '%PATH%', '!value!', 'a&b', 'a|b', 'a<b', 'a>b', '(a)', 'a^b'])(
    'rejects a command-script metacharacter sequence: %s',
    (argument) => {
      expect(() => windowsCommandScriptArgv('cmd.exe', 'agent.cmd', [argument]))
        .toThrow('cannot contain control or command metacharacters')
    },
  )
})
