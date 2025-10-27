import esbuild from 'esbuild'
import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const packageJson = JSON.parse(readFileSync('./package.json', 'utf-8'))

// Native modules that should not be bundled (read from production dependencies)
const externalModules = Object.keys(packageJson.dependencies || {})

console.log('External modules (not bundled):', externalModules)

const commonConfig = {
	bundle: true,
	platform: 'node',
	target: 'node20',
	format: 'esm',
	sourcemap: true,
	packages: 'bundle',
	external: externalModules,
	banner: {
		js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
	},
	logLevel: 'info',
	minify: false,
	keepNames: true,
}

async function build() {
	console.log('Building server code with esbuild...')

	try {
		// Build instrumentation
		await esbuild.build({
			...commonConfig,
			entryPoints: ['src/server/instrumentation.ts'],
			outfile: 'dist-server/instrumentation.js',
		})
		console.log('✓ Built instrumentation')

		// Build main server
		await esbuild.build({
			...commonConfig,
			entryPoints: ['src/server/main.ts'],
			outfile: 'dist-server/main.js',
		})
		console.log('✓ Built main server')

		console.log('Build completed successfully!')
	} catch (error) {
		console.error('Build failed:', error)
		process.exit(1)
	}
}

build()
