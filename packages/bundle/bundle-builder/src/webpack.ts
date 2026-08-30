/** Webpack helpers shared by package-client and remote-container builds. */

import { createRequire } from 'node:module'
import webpack from 'webpack'
import type { Configuration, Stats } from 'webpack'

const require = createRequire(import.meta.url)

/** Run one Webpack compiler and reject warnings or errors with formatted diagnostics. */
export function runWebpack(config: Configuration): Promise<Stats> {
  return new Promise((resolve, reject) => {
    const compiler = webpack(config)
    compiler.run((error, stats) => {
      compiler.close((closeError) => {
        /* v8 ignore start -- these callback-only outcomes require Webpack compiler or
         * shutdown infrastructure faults; product compilation errors are reported in stats. */
        if (error !== null) {
          reject(error)
          return
        }
        if (closeError !== null) {
          reject(closeError)
          return
        }
        if (stats === undefined) {
          reject(new Error('dsh-bundle: Webpack returned no build stats'))
          return
        }
        /* v8 ignore stop */
        if (stats.hasErrors()) {
          reject(new Error(stats.toString({ all: false, errors: true, errorDetails: true, colors: false })))
          return
        }
        resolve(stats)
      })
    })
  })
}

/** TypeScript, TSX, and CSS rules used by Builder-owned Webpack artifacts. */
export function bundleRules(): NonNullable<NonNullable<Configuration['module']>['rules']> {
  return [{
    test: /\.[cm]?[jt]sx?$/,
    exclude: /node_modules/,
    use: {
      loader: require.resolve('swc-loader'),
      options: {
        jsc: {
          parser: { syntax: 'typescript', tsx: true, decorators: true },
          transform: { react: { runtime: 'automatic' } },
        },
      },
    },
  }, {
    test: /\.css$/,
    use: [{ loader: require.resolve('style-loader') }, {
      loader: require.resolve('css-loader'),
      options: {
        modules: { auto: /\.module\.css$/, localIdentName: 'dsh_[hash:base64:8]' },
        url: false,
      },
    }],
  }, {
    test: /\.(?:png|jpe?g|gif|svg|webp|woff2?)$/,
    type: 'asset',
    generator: {
      filename: 'assets/[contenthash][ext]',
    },
  }]
}

/** Exact aliases for Builder-configured patch module sources. */
export function exactAliases(modules: ReadonlyMap<string, string>): Record<string, string> {
  return Object.fromEntries([...modules]
    .filter(([, entry]) => entry.startsWith('/') || /^[A-Za-z]:[/\\]/.test(entry))
    .map(([specifier, entry]) => [`${specifier}$`, entry]))
}

/** Resolve the Module Federation Node runtime plugin from the Builder installation. */
export function nodeRuntimePlugin(): string {
  return require.resolve('@module-federation/node/runtimePlugin')
}
