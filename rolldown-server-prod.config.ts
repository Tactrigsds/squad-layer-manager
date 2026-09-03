import { builtinModules } from 'node:module'
import path from 'node:path'
import { defineConfig } from 'rolldown'

import packageJson from './package.json'
import { extractMessages } from './src/scripts/messages-build.ts'

// Mainly just using rolldown through vite here. haven't explored using vite as a dev server, which we would need to do if we wanted to do any kind of transforms for the server code

// Native or OpenTelemetry instrumented modules that should not be bundled (read from production dependencies).
//
// So `dependencies` here means "what rolldown leaves external", not "what production needs". Everything the server
// imports is bundled either way. Moving a package between `dependencies` and `devDependencies` therefore changes
// how it is built, not whether it ships: demote one that must stay external (a native addon, or anything otel
// patches at require time) and it gets inlined, and the instrumentation silently stops applying.
const externalModules: (string | RegExp)[] = Object.keys(packageJson.dependencies || {})

externalModules.push(
	...builtinModules,
	...builtinModules.map((m) => `node:${m}`),
	// 'zlib-sync',
	// Tailwind (a devDependency) is only reached via the dynamic import in landing.server.ts, which runs in
	// dev/test; prod reads the prebuilt dist/landing.css. Externalize so its native oxide binary is never bundled.
	'postcss',
	'@tailwindcss/postcss',
)

console.log('External modules (not bundled):', externalModules)
export default defineConfig({
	plugins: [
		{
			name: 'slm:message-catalogues',
			buildStart() {
				extractMessages()
			},
		},
	],
	input: {
		'main-instrumented': 'src/server/main-instrumented.ts',
		// the history query engine's worker thread; a sibling of the main chunk so history.server.ts can
		// resolve it relative to import.meta.url in both dev and prod
		'history-query.worker': 'src/systems/history-query.worker.ts',
		// Schema (.sql) + data (.ts) migration runner. Bundled so the statically-imported
		// .ts migration registry ships in the slim prod image; .sql files are read at
		// runtime from the copied drizzle-sqlite/ folder.
		'scripts/migrate': 'src/scripts/migrate.ts',
		// Puts a backup back (`pnpm db:restore:prod`, or the restore.sh wrapper). Bundled for the same reason as the
		// migration runner: it reads the migration registry, to say whether the database it restored is behind the build.
		'scripts/restore': 'src/scripts/restore.ts',
		// Layer-db (re)build pipeline. Bundled so it can run in the slim prod image against a
		// mounted /app/data volume; it builds the layer db schema in-process (no drizzle-kit),
		// so no config/src tree is needed at runtime. Run via `pnpm run preprocess:prod`.
		'scripts/preprocess': 'src/scripts/preprocess.ts',
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
