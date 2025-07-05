import basicSsl from '@vitejs/plugin-basic-ssl'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'
import * as AR from './src/app-routes.ts'
import { ensureEnvSetup } from './src/server/env.ts'
import * as Env from './src/server/env.ts'

const prod = process.env.NODE_ENV === 'production'

// https://vitejs.dev/config/
export default defineConfig({
	plugins: [react(), tsconfigPaths(), { name: 'configure-response-headers' }],
	server: {
		proxy: !prod ? buildProxy() : undefined,
		headers: {
			// required for sqlocal
			'Cross-Origin-Embedder-Policy': 'require-corp',
			'Cross-Origin-Opener-Policy': 'same-origin',
		},
	},
	envPrefix: 'PUBLIC_',
	build: {
		sourcemap: true,
	},
	optimizeDeps: {
		exclude: ['sqlocal'],
	},
})

function buildProxy() {
	ensureEnvSetup()
	const ENV = Env.getEnvBuilder({ ...Env.groups.httpServer })()
	return Object.fromEntries(
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
}
