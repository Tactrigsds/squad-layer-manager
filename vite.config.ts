/// <reference types="vitest/config" />
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import type { ServerResponse } from 'node:http'
import path from 'node:path'
import type { CommonServerOptions, Plugin, UserConfig } from 'vite'
import { defineConfig } from 'vite'
import { ViteEjsPlugin } from 'vite-plugin-ejs'

import * as AR from './src/app-routes.ts'
import { BUILD_TARGET } from './src/browser-support.ts'
import { extractMessages } from './src/scripts/messages-build.ts'
import * as Env from './src/server/env.ts'

Env.ensureEnvSetup()
const ENV = Env.getEnvBuilder({ ...Env.groups.general })()

// Feeds plugins/builtins.ts the source of every plugin directory, in dev only. It is a virtual module
// rather than a glob guarded by import.meta.env.DEV because a glob's imports are real: eager ones
// survive dead-code elimination, and a plugin author's own repo cloned into plugins/ ended up in the
// shipped bundle. A build gets the empty stub, so it cannot.
function devSourcePlugins(): Plugin {
	const ID = 'virtual:slm-dev-plugins'
	const RESOLVED = '\0' + ID
	let serving = false
	return {
		name: 'slm-dev-source-plugins',
		configResolved(config) {
			serving = config.command === 'serve'
		},
		resolveId(id) {
			return id === ID ? RESOLVED : null
		},
		load(id) {
			if (id !== RESOLVED) return null
			if (!serving) return 'export const manifests = {}\nexport const clients = {}\n'
			// two levels, matching sourceDirs() in plugins/builtins.server.ts: one repo can hold several plugins
			return [
				"export const manifests = { ...import.meta.glob('/plugins/*/plugin.ts', { eager: true }), ...import.meta.glob('/plugins/*/*/plugin.ts', { eager: true }) }",
				"export const clients = { ...import.meta.glob('/plugins/*/client.tsx'), ...import.meta.glob('/plugins/*/*/client.tsx') }",
			].join('\n')
		},
	}
}

function messageCatalogues(): Plugin {
	return {
		name: 'slm:message-catalogues',
		buildStart() {
			extractMessages()
		},
		configureServer(server) {
			server.watcher.add(['src/**/*.ts', 'src/**/*.tsx', 'src/messages/locales/*.json'])
		},
		handleHotUpdate({ file }) {
			if (
				!file.startsWith(path.resolve('src') + path.sep) ||
				/\.test\.tsx?$/.test(file) ||
				file.startsWith(path.resolve('src/scripts') + path.sep)
			)
				return
			extractMessages()
		},
	}
}

// https://vitejs.dev/config/
export default defineConfig({
	plugins: [
		devSourcePlugins(),
		messageCatalogues(),
		tanstackRouter({
			target: 'react',
		}),
		ViteEjsPlugin({
			NODE_ENV: ENV.NODE_ENV,
		}),
		quietCompilerBailouts(react({ compiler: true })),
		declareOrphanedRefreshGlobals(),
		{
			name: 'html-proxy-middleware',
			configureServer(server) {
				return () => {
					server.middlewares.use(async (req, res, next) => {
						const acceptHeader = req.headers.accept || ''

						if (req.url && acceptHeader.includes('text/html') && res.statusCode === 200) {
							try {
								Env.ensureEnvSetup()
								const ENV = Env.getEnvBuilder({ ...Env.groups.httpServer })()
								const proxyUrl = `http://${ENV.HOST}:${ENV.PORT}${req.originalUrl}`

								// req.headers can have symbols attached when using vite-rolldown, and metadata prefixed with :
								const headers = Object.fromEntries(Object.entries(req.headers).filter(([key]) => !key.startsWith(':'))) as Record<
									string,
									string
								>

								const proxyRes = await fetch(proxyUrl, {
									method: 'GET',
									redirect: 'manual',
									headers,
								})

								// non-200 responses (redirects, 403) and marked static pages (the landing page, a 200) carry their
								// own body; anything else is a 200 the SPA should hydrate, so fall through to vite's index.html
								if (proxyRes.status !== 200 || proxyRes.headers.get('x-slm-static-page')) {
									console.log(`Upstream returned ${proxyRes.status}, proxying entire response`)
									res.statusCode = proxyRes.status

									// Copy all headers from upstream
									proxyRes.headers.forEach((value, key) => {
										const name = key.toLowerCase()
										if (name === 'keep-alive' || name === 'connection' || name === 'set-cookie') return
										res.setHeader(key, value)
									})
									copyCookies(proxyRes, res)

									// Pipe the body
									const body = await proxyRes.text()
									res.end(body)
									return
								} else {
									copyCookies(proxyRes, res)
									next()
								}
							} catch (error) {
								console.error('Error fetching upstream headers:', error)
								next()
							}
						} else {
							next()
						}
					})
				}
			},
		},
	],
	server: process.env.NODE_ENV === 'development' ? buildDevServerConfig() : undefined,
	build: {
		sourcemap: true,
		// syntax the floor cannot parse is lowered rather than shipped. This covers only syntax; `pnpm check:compat`
		// is what checks the apis and css the bundle reaches for.
		target: BUILD_TARGET,
	},
	// optimizeDeps: {
	// 	exclude: ['ace-builds'],
	// },
	resolve: {
		alias: {
			'@': path.resolve(import.meta.dirname, 'src'),
			$root: path.resolve(import.meta.dirname),
			slm: path.resolve(import.meta.dirname, 'src/plugin-api'),
		},
	},
	test: {
		// layer data is loaded at runtime rather than bundled, so tests need it loaded up-front
		setupFiles: ['./src/vitest-setup.ts'],
		// integration tests boot the whole app (`pnpm test:integration`) and e2e tests run under playwright
		// (`pnpm test:e2e`); neither belongs to the unit run
		exclude: ['**/node_modules/**', 'test/integration/**', 'test/e2e/**', '.claude/**'],
	},
})

// React Compiler warns once per function it declines to optimize, which is ~290 codeframes on every build, dev
// boot and vitest run. oxlint reports the same bailouts as `react/*` rules, so the linter owns them and the build
// stays readable. A fatal transform error still comes through `this.error`.
function quietCompilerBailouts(plugins: Plugin[]): Plugin[] {
	for (const plugin of plugins) {
		if (plugin.name !== 'vite:react-compiler' || typeof plugin.transform !== 'object') continue
		const transform = plugin.transform
		const handler = transform.handler
		transform.handler = function (...args) {
			return handler.apply(Object.create(this, { warn: { value: () => {} } }), args)
		}
	}
	return plugins
}

// @vitejs/plugin-react asks for Fast Refresh on every file its compiler plugin touches, but the wrapper that
// declares `$RefreshReg$` only runs on modules that export components. Anything in between is left calling globals
// nobody declared. The window's preamble hides that behind a no-op; a web worker has no preamble, so the
// layer-queries worker dies on `$RefreshReg$ is not defined` before it initializes.
//
// Runs post so it sees whether the wrapper declared them. Declarations hoist, so appending covers calls above.
// Drop this once the plugin stops injecting refresh into modules it does not wrap.
function declareOrphanedRefreshGlobals(): Plugin {
	return {
		name: 'slm:orphaned-refresh-globals',
		enforce: 'post',
		apply: 'serve',
		transform(code) {
			if (!code.includes('$RefreshReg$(') && !code.includes('$RefreshSig$()')) return
			if (code.includes('function $RefreshReg$')) return
			return {
				code: code + '\nfunction $RefreshReg$() {}\nfunction $RefreshSig$() { return (type) => type }\n',
				map: null,
			}
		},
	}
}

// Headers.get('set-cookie') joins multiple cookies into one comma-separated header, which a browser reads as a
// single cookie with garbage attributes: logging in through this port set the session and silently dropped
// every cookie after it. getSetCookie keeps them apart.
function copyCookies(from: Response, to: ServerResponse) {
	const cookies = from.headers.getSetCookie()
	if (cookies.length > 0) to.setHeader('set-cookie', cookies)
}

function buildDevServerConfig(): UserConfig['server'] {
	Env.ensureEnvSetup()
	// don't resolve these in prod
	const ENV = Env.getEnvBuilder({ ...Env.groups.httpServer })()
	const proxy: CommonServerOptions['proxy'] = {}
	for (const r of AR.routes) {
		if (r.handle === 'page') continue
		const protocol = r.websocket ? 'ws://' : 'http://'
		const target = `${protocol}${ENV.HOST}:${ENV.PORT}`
		console.log(`proxying ${r.id} to ${target}`)
		proxy[AR.getRouteRegex(r.id).source] = {
			target,
			changeOrigin: true,
			ws: r.websocket,
		}
	}
	return {
		port: ENV.CLIENT_PORT,
		// ORIGIN is pinned to this port, as is any port mapping in front of it. Quietly falling through to
		// the next free one would serve the client somewhere nothing else expects it, so fail where it can
		// be seen instead. Set CLIENT_PORT to run a second instance beside a running one.
		strictPort: true,
		proxy,
		headers: {
			// required for sqlocal
			'Cross-Origin-Embedder-Policy': 'credentialless',
			'Cross-Origin-Opener-Policy': 'same-origin',
		},
	}
}
