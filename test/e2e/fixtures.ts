import { test as base } from '@playwright/test'
import { type AppFixture, createAppFixture } from '../harness/app-fixture'

// Playwright fixture: one app instance + one emulated squad server per test file (worker-scoped),
// so a test can drive the real UI, act "in game" through the emulator, and assert against the UI,
// the emulator's received RCON commands, and the app's database.

export const test = base.extend<{ app: AppFixture; freshApp: AppFixture }, { workerApp: AppFixture }>({
	// eslint-disable-next-line no-empty-pattern -- playwright's fixture signature requires the deps arg
	workerApp: [async ({}, use) => {
		const app = await createAppFixture()
		await use(app)
		await app.dispose()
	}, { scope: 'worker', timeout: 180_000 }],

	app: async ({ workerApp }, use) => {
		await use(workerApp)
	},

	// a private app + emulator for one test. Costs a boot (~10s), so reach for it only when the test
	// needs a starting state the shared app can't give it (its own seeded queue, settings, admins) or
	// when it would leave state the other tests would trip over.
	// eslint-disable-next-line no-empty-pattern -- playwright's fixture signature requires the deps arg
	freshApp: async ({}, use, testInfo) => {
		const app = await createAppFixture()
		testInfo.setTimeout(testInfo.timeout + 120_000)
		await use(app)
		await app.dispose()
	},

	// every test starts logged in as the seeded admin
	page: async ({ page, workerApp }, use) => {
		await page.goto(workerApp.loginUrl())
		await use(page)
	},
})

export { expect } from '@playwright/test'
