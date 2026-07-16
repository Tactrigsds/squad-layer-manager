import path from 'node:path'
import { defineConfig } from 'vitest/config'

// Integration tests: boot the real app as a child process against the squad server emulator
// (see test/harness/app-fixture.ts). Run with `pnpm test:integration`.
export default defineConfig({
	resolve: {
		alias: {
			'@': path.resolve(__dirname, 'src'),
			'$root': path.resolve(__dirname),
		},
	},
	test: {
		include: ['test/integration/**/*.test.ts'],
		exclude: ['.claude/**'],
		setupFiles: ['./src/vitest-setup.ts'],
		testTimeout: 60_000,
		hookTimeout: 120_000,
		// each file boots its own app (child process, ephemeral db + ports), so files are isolated by
		// construction and can run together. Capped rather than unbounded: every app loads the layer db.
		fileParallelism: true,
		maxWorkers: 4,
	},
})
