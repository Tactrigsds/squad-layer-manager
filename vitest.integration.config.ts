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
		setupFiles: ['./src/vitest-setup.ts'],
		testTimeout: 60_000,
		hookTimeout: 120_000,
		// each fixture owns a child process + ports; keep suites sequential for predictable load
		fileParallelism: false,
	},
})
