#!/usr/bin/env node
/** Command-line interface for DSH Bundle builds. */

import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { buildBundle, lintBundle } from './index.ts'
import type { BundleBuilderOverrides, BundleBuilderTarget } from './project.ts'

interface ParsedArgs extends BundleBuilderOverrides {
  command: 'build' | 'lint' | 'serve'
  host: string
  port: number
}

function usage(): string {
  return `Usage: dsh-bundle <build|lint|serve> [options]

Options:
  --target <package|remote|dual>  artifact target (default: dual)
  --out-dir <path>               output directory (default: dist)
  --build-id <id>                immutable remote build id (default: UUID)
  --cwd <path>                   Bundle project directory (default: cwd)
  --host <address>               serve bind address (default: 127.0.0.1)
  --port <number>                serve port (default: 4173)
  -h, --help                     show this help
`
}

function value(args: readonly string[], index: number, flag: string): string {
  const result = args[index + 1]
  if (result === undefined || result.startsWith('-')) throw new Error(`dsh-bundle: ${flag} requires a value`)
  return result
}

function parseArgs(args: readonly string[]): ParsedArgs | undefined {
  if (args.includes('--help') || args.includes('-h')) return undefined
  const command = args[0]
  if (command !== 'build' && command !== 'lint' && command !== 'serve') {
    throw new Error('dsh-bundle: expected build, lint, or serve')
  }
  const parsed: ParsedArgs = { command, host: '127.0.0.1', port: 4173 }
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--target') {
      const target = value(args, index, argument)
      if (target !== 'package' && target !== 'remote' && target !== 'dual') {
        throw new Error('dsh-bundle: --target must be package, remote, or dual')
      }
      parsed.target = target satisfies BundleBuilderTarget
      index += 1
    } else if (argument === '--out-dir') {
      parsed.outDir = value(args, index, argument)
      index += 1
    } else if (argument === '--build-id') {
      parsed.buildId = value(args, index, argument)
      index += 1
    } else if (argument === '--cwd') {
      parsed.cwd = value(args, index, argument)
      index += 1
    } else if (argument === '--host') {
      parsed.host = value(args, index, argument)
      index += 1
    } else if (argument === '--port') {
      const port = Number(value(args, index, argument))
      if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('dsh-bundle: --port must be 0..65535')
      parsed.port = port
      index += 1
    } else {
      throw new Error(`dsh-bundle: unknown option ${JSON.stringify(argument)}`)
    }
  }
  return parsed
}

const CONTENT_TYPES: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

async function serve(parsed: ParsedArgs): Promise<void> {
  const result = await buildBundle({ ...parsed, target: 'remote' })
  const root = join(result.project.outDir, 'remote')
  const server = createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD', 'access-control-allow-origin': '*' })
      response.end()
      return
    }
    let pathname: string
    try {
      pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://dsh.invalid').pathname)
    } catch {
      response.writeHead(400, { 'access-control-allow-origin': '*' })
      response.end()
      return
    }
    const relative = pathname === '/' ? 'dsh-bundle.json' : pathname.slice(1)
    const path = resolve(root, relative)
    if ((path !== root && !path.startsWith(`${root}${sep}`)) || !existsSync(path) || !statSync(path).isFile()) {
      response.writeHead(404, { 'access-control-allow-origin': '*' })
      response.end()
      return
    }
    response.writeHead(200, {
      'access-control-allow-origin': '*',
      'content-type': CONTENT_TYPES[extname(path)] ?? 'application/octet-stream',
      'cache-control': relative === 'dsh-bundle.json' ? 'no-cache' : 'public, max-age=31536000, immutable',
    })
    if (request.method === 'HEAD') response.end()
    else createReadStream(path).pipe(response)
  })
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(parsed.port, parsed.host, () => { resolveListen() })
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : parsed.port
  process.stdout.write(`http://${parsed.host}:${String(port)}/dsh-bundle.json\n`)
}

try {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed === undefined) {
    process.stdout.write(usage())
  } else if (parsed.command === 'lint') {
    const project = lintBundle(parsed)
    process.stdout.write(`dsh-bundle: ${project.name} is valid\n`)
  } else if (parsed.command === 'serve') {
    await serve(parsed)
  } else {
    const result = await buildBundle(parsed)
    if (result.packageDir !== undefined) process.stdout.write(`package: ${result.packageDir}\n`)
    if (result.remoteManifest !== undefined) process.stdout.write(`remote: ${result.remoteManifest}\n`)
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
