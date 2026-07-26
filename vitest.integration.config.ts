import * as os from 'node:os'
import path from 'node:path'
import { defineConfig } from 'vitest/config'

// Integration tests: boot the real app as a child process against the squad server emulator
// (see test/harness/app-fixture.ts). Run with `pnpm test:integration`.

// Each file boots its own app (child process, ephemeral db + ports), so files are isolated by construction and
// can run together. Bounded rather than unbounded because every one of those apps is a whole server, and the
// apps contend for more than CPU: the poll intervals in applyTestServerTimings are only safe while RCON
// responses come back inside core-rcon's 2s timeout. Measured on 16 cores: 4 workers 41s, 6 workers 31s,
// 8 workers 29s -- the ceiling is 6 because the last 2s is not worth doubling the RCON contention the poll
// intervals were tuned against. The floor of 4 is what a small CI runner was already doing.
const WORKERS = Math.max(4, Math.min(6, Math.floor(os.cpus().length / 2)))

export default defineConfig({
	resolve: {
		alias: {
			'@': path.resolve(__dirname, 'src'),
			$root: path.resolve(__dirname),
		},
	},
	test: {
		include: ['test/integration/**/*.test.ts'],
		exclude: ['.claude/**'],
		setupFiles: ['./src/vitest-setup.ts'],
		testTimeout: 60_000,
		hookTimeout: 120_000,
		fileParallelism: true,
		maxWorkers: WORKERS,
	},
})
