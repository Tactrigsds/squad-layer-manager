import react from '@vitejs/plugin-react-swc'
import { defineConfig } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'
import * as AR from './src/app-routes.ts'
import { ensureEnvSetup } from './src/server/env.ts'
import * as Env from './src/server/env.ts'

const prod = process.env.NODE_ENV === 'production'

// https://vitejs.dev/config/
export default defineConfig({
	plugins: [react(), tsconfigPaths()],
	server: {
		proxy: !prod ? buildProxy() : undefined,
	},
	envPrefix: 'PUBLIC_',
	build: {
		sourcemap: true,
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
