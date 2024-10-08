import react from '@vitejs/plugin-react-swc'
import { defineConfig } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'

import * as AppRoutes from './src/appRoutes'

// https://vitejs.dev/config/
export default defineConfig({
	plugins: [react(), tsconfigPaths()],
	server: {
		// headers: {
		// 'Cross-Origin-Opener-Policy': 'same-origin',
		// 'Cross-Origin-Embedder-Policy': 'require-corp',
		// },
		proxy: Object.fromEntries(
			AppRoutes.routes.map((r) => {
				const target = r.websocket ? 'ws://localhost:3000' : 'http://localhost:3000'
				return [`^${r.client}$}`, { target, changeOrigin: true, ws: r.websocket }]
			})
		),
	},
	build: {
		sourcemap: true,
	},
})
