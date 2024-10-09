import react from '@vitejs/plugin-react-swc'
import { defineConfig } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'

import * as AR from './src/app-routes.ts'

// https://vitejs.dev/config/
export default defineConfig({
	plugins: [react(), tsconfigPaths()],
	server: {
		// headers: {
		// 'Cross-Origin-Opener-Policy': 'same-origin',
		// 'Cross-Origin-Embedder-Policy': 'require-corp',
		// },
		proxy: newFunction(),
	},
	build: {
		sourcemap: true,
	},
})

function newFunction() {
	const stuff = Object.fromEntries(
		Object.values(AR.routes).map((r) => {
			const target = r.websocket ? 'ws://localhost:3000' : 'http://localhost:3000'
			return [`^${r.client}(\\?.+)?$`, { target, changeOrigin: true, ws: r.websocket }]
		})
	)
	return stuff
}
