import react from '@vitejs/plugin-react-swc'
import { defineConfig } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'

import * as AR from './src/app-routes.ts'
import { ENV, setupEnv } from './src/server/env.ts'

const prod = process.env.NODE_ENV === 'production'

// https://vitejs.dev/config/
export default defineConfig({
	plugins: [react(), tsconfigPaths()],
	server: {
		proxy: !prod ? buildProxy() : undefined,
	},
	build: {
		sourcemap: true,
	},
})

function buildProxy() {
	setupEnv()
	return Object.fromEntries(
		Object.values(AR.routes).map((r) => {
			const target = r.websocket ? `ws://localhost:${ENV.PORT}` : `http://localhost:${ENV.PORT}`
			return [
				`^${r.client}(\\?.+)?$`,
				{
					target,
					changeOrigin: true,
					ws: r.websocket,
				},
			]
		})
	)
}
