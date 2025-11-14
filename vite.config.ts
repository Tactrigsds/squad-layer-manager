import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'
import { CommonServerOptions, defineConfig, UserConfig } from 'vite'
import { ViteEjsPlugin } from 'vite-plugin-ejs'
import oxLintPlugin from 'vite-plugin-oxlint'
import * as AR from './src/app-routes.ts'
import { ensureEnvSetup } from './src/server/env.ts'
import * as Env from './src/server/env.ts'

ensureEnvSetup()
const ENV = Env.getEnvBuilder({ ...Env.groups.general })()

// https://vitejs.dev/config/
export default defineConfig({
	plugins: [
		oxlintPlugin(),
		tanstackRouter({
			target: 'react',
		}),
		ViteEjsPlugin({
			REACT_SCAN_ENABLED_OVERRIDE: ENV.REACT_SCAN_ENABLED_OVERRIDE,
			NODE_ENV: ENV.NODE_ENV,
		}),
		react({
			babel: {
				plugins: ['babel-plugin-react-compiler'],
			},
		}),
		{
			name: 'html-proxy-middleware',
			configureServer(server) {
				return () => {
					server.middlewares.use((req, res, next) => {
						const acceptHeader = req.headers.accept || ''

						if (req.url && acceptHeader.includes('text/html') && res.statusCode === 200) {
							ensureEnvSetup()
							const ENV = Env.getEnvBuilder({ ...Env.groups.httpServer })()
							const proxyUrl = `http://${ENV.HOST}:${ENV.PORT}${req.originalUrl}`
							console.log(`Fetching from upstream:`, proxyUrl)

							fetch(proxyUrl, {
								method: 'GET',
								headers: req.headers as RequestInit['headers'],
							})
								.then(async (proxyRes) => {
									if (proxyRes.status !== 200) {
										// Proxy the entire response if not 200
										console.log(`Upstream returned ${proxyRes.status}, proxying entire response`)
										res.statusCode = proxyRes.status

										// Copy all headers from upstream
										proxyRes.headers.forEach((value, key) => {
											res.setHeader(key, value)
										})

										// Pipe the body
										const body = await proxyRes.text()
										res.end(body)
									} else {
										// Apply cookie header from upstream server
										const cookieHeader = proxyRes.headers.get('set-cookie')
										if (cookieHeader) {
											res.setHeader('set-cookie', cookieHeader)
										}

										next()
									}
								})
								.catch((error) => {
									console.error('Error fetching upstream headers:', error)
									next()
								})
						} else {
							next()
						}
					})
				}
			},
		},
	],
	server: process.env.NODE_ENV === 'development' ? buildDevServerConfig() : undefined,
	envPrefix: 'PUBLIC_',
	build: {
		sourcemap: true,
	},
	optimizeDeps: {
		exclude: [],
	},
	resolve: {
		alias: {
			'@': path.resolve(__dirname, 'src'),
			'$root': path.resolve(__dirname),
		},
	},
})

function buildDevServerConfig(): UserConfig['server'] {
	ensureEnvSetup()
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
		proxy,
		https: {
			key: fs.readFileSync(path.resolve('.', 'certs/localhost-key.pem')),
			cert: fs.readFileSync(path.join('.', 'certs/localhost.pem')),
		},
		headers: {
			// required for sqlocal
			'Cross-Origin-Embedder-Policy': 'require-corp',
			'Cross-Origin-Opener-Policy': 'same-origin',
		},
	}
}
