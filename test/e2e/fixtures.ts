import { test as base } from '@playwright/test'

import * as FB from '@/models/filter-builders'

import { type AppFixture, createAppFixture, setCurrentTestLabel } from '../harness/app-fixture'
import { filter } from '../harness/arrange'

// Playwright fixture: one app instance + one emulated squad server per test file (worker-scoped),
// so a test can drive the real UI, act "in game" through the emulator, and assert against the UI,
// the emulator's received RCON commands, and the app's database.

// The shared app starts with an empty queue and generates one, so what its tests read out of the queue is
// whatever the draw returned, and an unconstrained draw is mostly mod layers. Those do not display as
// Map_Gamemode_vN: a mod layer carries its collection ('Umbara_RAAS_v3_GC') and a training layer collapses to
// the bare map name ('Umbara'), which also makes SLM's set-next disagree with the layer the server reports
// back and prepend it to the queue again. Every real pool is filtered; this is the shared app's.
const SHARED_POOL_FILTER = filter('shared-app-pool', 'Vanilla RAAS', FB.and([FB.eq('Gamemode', 'RAAS'), FB.eq('Collection', 'OWI')]))

export const test = base.extend<{ app: AppFixture; freshApp: AppFixture; labelTelemetry: void }, { workerApp: AppFixture }>({
	// so that every app built during a test -- including the ones test files build themselves -- exports its
	// telemetry under that test's name (see SLM_TEST_OTEL)
	labelTelemetry: [
		// eslint-disable-next-line no-empty-pattern -- playwright's fixture signature requires the deps arg
		async ({}, use, testInfo) => {
			setCurrentTestLabel(testInfo.titlePath.join(' > '))
			await use()
			setCurrentTestLabel(undefined)
		},
		{ auto: true },
	],

	workerApp: [
		// eslint-disable-next-line no-empty-pattern -- playwright's fixture signature requires the deps arg
		async ({}, use) => {
			const app = await createAppFixture({
				filters: [SHARED_POOL_FILTER],
				serverSettings: (settings) =>
					settings.queue.mainPool.constrainGeneration.push({ filterId: SHARED_POOL_FILTER.id, applyAs: 'regular' }),
			})
			await use(app)
			await app.dispose()
		},
		{ scope: 'worker', timeout: 180_000 },
	],

	// Asking for this is what boots the shared app, so a file whose tests each build their own never pays for
	// one -- which is most of them, and every one of them used to boot a second app it never touched.
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
})

// For the files whose tests all drive the shared app: every page starts on it, logged in as the seeded admin.
// A file opts in by importing this instead of `test`, rather than each test asking for `app`, because a test
// can read the page without naming `app` at all and would otherwise silently get a blank one.
export const sharedAppTest = test.extend({
	page: async ({ page, app }, use) => {
		await page.goto(app.loginUrl())
		await use(page)
	},
})

export { expect } from '@playwright/test'
