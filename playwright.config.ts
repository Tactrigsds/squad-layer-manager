import { defineConfig, devices } from '@playwright/test'

// E2E tests drive the real client against a real app instance backed by the squad server emulator
// (see test/e2e/fixtures.ts). The app is spawned per test file by the fixture rather than by a
// `webServer` here, because each one serves its own frontend on its own port.
//
// The client bundle must be built first: `pnpm test:e2e` does that for you.
export default defineConfig({
	testDir: './test/e2e',
	// each test file gets its own app + emulator (worker-scoped fixture), so files are isolated and can
	// run in parallel; tests within a file share that app and run in order
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: 0,
	workers: 4,
	reporter: process.env.CI ? 'line' : 'list',
	timeout: 60_000,
	expect: { timeout: 15_000 },
	use: {
		// chromium cannot use its sandbox inside a container without extra privileges, and the container
		// is the isolation boundary here anyway
		launchOptions: process.env.CI ? { args: ['--no-sandbox'] } : {},
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
		// selectors must be role/label-based, so tests double as an accessibility check on the markup
		testIdAttribute: 'data-test-id',
	},
	projects: [
		{ name: 'chromium', use: { ...devices['Desktop Chrome'] } },
	],
})
