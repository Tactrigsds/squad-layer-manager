import { defineConfig, devices } from '@playwright/test'

// The fixtures import app modules that resolve env, which requires NODE_ENV. Vitest defaults it to
// 'test' and the docker image sets it, but a bare `playwright test` has neither, so default it here
// (config is loaded in every worker before the test files are).
process.env.NODE_ENV ??= 'test'

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
	// Not raised, deliberately. A worker here is a browser and an app between them, and several of these tests
	// wait on a cold client load inside a fixed ceiling; measured on 16 cores, 8 workers took the suite from 48s
	// to 41s and 6 workers produced one such wait timing out. Those ceilings are what to fix first if this is to
	// go up.
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
		// Gecko differs from Blink in the places this app leans hardest: pointer-driven drag and drop, portalled
		// overlays, and above all the layer table, whose every page is a wasm query over 2.7M layers. Running the
		// whole suite on it costs as much again as chromium and mostly re-tests the server, so this project runs
		// only what is tagged @firefox. `pnpm test:e2e:firefox` runs it.
		//
		// The timeouts are several times chromium's on purpose. Firefox takes tens of seconds to do what chromium
		// does in one or two on the layer-query path, and every one of these tests waits on a query somewhere. Set
		// this low and the suite reports that gap over and over, drowning the thing it is here to find; set it high
		// and a failure means gecko behaved differently. An inline `{ timeout: n }` on an assertion overrides these,
		// so a test that waits on a query must not carry one.
		//
		// The one genuine behavioural difference found so far is in drag and drop, and it is not a timeout: see
		// test/harness/drag.ts, which every drag in the suite goes through.
		{
			name: 'firefox',
			grep: /@firefox/,
			timeout: 300_000,
			expect: { timeout: 90_000 },
			use: { ...devices['Desktop Firefox'] },
		},
	],
})
