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
	// The migration script imports the `mysql2/promise` subpath. The bare-name
	// entries above only externalize exact ids, so keep mysql2's subpaths external
	// too — bundling mysql2 breaks its dynamic auth-plugin requires at runtime.
	/^mysql2\//,
	// 'zlib-sync',
)

console.log('External modules (not bundled):', externalModules)
export default defineConfig({
	input: {
		'main-instrumented': 'src/server/main-instrumented.ts',
		// One-shot MySQL -> SQLite data migration. Bundled so it can run inside the
		// slim production image (no src tree / tsx). mysql2 stays external via prod deps.
		'scripts/migrate-mysql-to-sqlite': 'src/scripts/migrate-mysql-to-sqlite.ts',
		// Schema (.sql) + data (.ts) migration runner. Bundled so the statically-imported
		// .ts migration registry ships in the slim prod image; .sql files are read at
		// runtime from the copied drizzle-sqlite/ folder.
		'scripts/migrate': 'src/scripts/migrate.ts',
	},
	tsconfig: path.resolve(__dirname, 'tsconfig.node.json'),
	platform: 'node',
	output: {
		sourcemap: true,
		dir: 'dist-server/',
		format: 'esm',
	},
	external: externalModules,
})
