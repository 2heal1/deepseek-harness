import { defineConfig } from 'tsdown'

/** Build the library, CLI, and invariant as independent Node ESM entries. */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/bin.js', 'lib/types/invariant.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
