/** Shared Windows executable classification and command-script encoding. */

import { win32 } from 'node:path'

const COMMAND_SCRIPT_EXTENSIONS = new Set(['.bat', '.cmd'])
const WINDOWS_NATIVE_EXTENSIONS = new Set(['.com', '.exe'])
const UNSAFE_COMMAND_SCRIPT_ARGUMENT = /[\0\r\n%!&|<>()^]/u

/**
 * Determine whether a resolved Windows path requires `cmd.exe` interpretation.
 * @param path - resolved executable path.
 * @returns whether the path names a `.cmd` or `.bat` file.
 */
export function isWindowsCommandScript(path: string): boolean {
  return COMMAND_SCRIPT_EXTENSIONS.has(win32.extname(path).toLowerCase())
}

/**
 * Reject Windows executable extensions the shared launcher does not support.
 * @param path - resolved executable path.
 */
export function assertSupportedWindowsExecutable(path: string): void {
  const extension = win32.extname(path).toLowerCase()
  if (!WINDOWS_NATIVE_EXTENSIONS.has(extension) && !COMMAND_SCRIPT_EXTENSIONS.has(extension)) {
    throw new Error(`agent runtime launcher does not support Windows executable extension "${extension}"`)
  }
}

function encodeCommandScriptArgument(argument: string): string {
  if (UNSAFE_COMMAND_SCRIPT_ARGUMENT.test(argument)) {
    throw new Error('agent runtime Windows command-script arguments cannot contain control or command metacharacters')
  }
  return `"${argument.replaceAll('"', '""')}"`
}

/**
 * Build the sole supported `.cmd`/`.bat` invocation.
 * @param comspec - absolute validated command interpreter path.
 * @param script - absolute validated command-script path.
 * @param args - dynamic script arguments.
 * @returns argv for direct `ComSpec` spawn.
 */
export function windowsCommandScriptArgv(
  comspec: string,
  script: string,
  args: readonly string[],
): readonly string[] {
  const command = `"${[script, ...args].map(encodeCommandScriptArgument).join(' ')}"`
  return [comspec, '/d', '/s', '/c', command]
}
