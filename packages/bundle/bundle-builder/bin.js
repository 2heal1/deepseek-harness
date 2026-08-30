#!/usr/bin/env node
/**
 * Stable installation target for the `dsh-bundle` command.
 *
 * Package managers create bin links before `lib/bin.js` exists in a clean
 * workspace, so this committed wrapper loads the built command at runtime.
 * @module @deepseek-ai/dsh-bundle-builder/bin
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const entry = new URL('./lib/bin.js', import.meta.url)
if (!existsSync(fileURLToPath(entry))) {
  process.stderr.write('dsh-bundle: lib/bin.js is missing — build @deepseek-ai/dsh-bundle-builder before running the command\n')
  process.exit(1)
}
await import(entry.href)
