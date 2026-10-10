import { defineConfig, devices } from '@playwright/test'

process.env.NODE_ENV ??= 'test'

// Client performance scenarios (test/perf). Each boots its own app and emulator, drives a fixed load, and writes a CPU
// profile plus a summary under perf-results. They measure rather than assert, so they are not part of
// `pnpm test:e2e`. Run with `pnpm test:perf`.
export default defineConfig({
	testDir: './test/perf',
	testMatch: '**/*.perf.ts',
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: 'list',
	timeout: 300_000,
	// wide enough that the queue, the teams and the activity feed are all on screen at once, as on an admin's monitor
	use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 } },
})
