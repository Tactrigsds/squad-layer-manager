import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'
import { defineConfig, UserConfig } from 'vite'
import * as AR from './src/app-routes.ts'
import { ensureEnvSetup } from './src/server/env.ts'
import * as Env from './src/server/env.ts'

// https://vitejs.dev/config/
export default defineConfig({
	plugins: [react()],
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
	const ENV = Env.getEnvBuilder({ ...Env.groups.httpServer })()
	const proxy = Object.fromEntries(
		Object.values(AR.routes).map((r) => {
			const protocol = r.websocket ? 'ws://' : 'http://'
			const target = `${protocol}${ENV.HOST}:${ENV.PORT}`
			return [
				`^${r.client}(\\?.+)?$`,
				{
					target,
					changeOrigin: true,
					ws: r.websocket,
				},
			]
		}),
	)
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
