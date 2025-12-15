import { builtinModules } from 'node:module'
import path from 'node:path'
import { defineConfig } from 'rolldown'
import packageJson from './package.json'

// Mainly just using rolldown through vite here. haven't explored using vite as a dev server, which we would need to do if we wanted to do any kind of transforms for the server code

// Native or OpenTelemetry instrumented modules that should not be bundled (read from production dependencies)
const externalModules: (string | RegExp)[] = Object.keys(packageJson.dependencies || {})

externalModules.push(
	...builtinModules,
	...builtinModules.map(m => `node:${m}`),
	// 'zlib-sync',
)

console.log('External modules (not bundled):', externalModules)

export default defineConfig({
	input: 'src/server/main-instrumented.ts',
	tsconfig: path.resolve(__dirname, 'tsconfig.node.json'),
	platform: 'node',
	output: {
		dir: 'dist-server/',
		format: 'esm',
	},
	external: externalModules,
})
