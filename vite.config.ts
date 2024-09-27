import react from '@vitejs/plugin-react-swc'
import { defineConfig } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'

// https://vitejs.dev/config/
export default defineConfig({
	plugins: [react(), tsconfigPaths()],
	server: {
		// headers: {
		// 'Cross-Origin-Opener-Policy': 'same-origin',
		// 'Cross-Origin-Embedder-Policy': 'require-corp',
		// },
		proxy: {
			'^/trpc/.*': {
				target: 'http://localhost:3000',
				changeOrigin: true,
			},
		},
	},
})
