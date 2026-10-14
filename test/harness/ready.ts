import { expect, type Page, test } from '@playwright/test'

import type * as Readiness from '@/systems/readiness.client'

// Waits for the client to finish starting, as src/systems/readiness.client.ts publishes it. A cold load -- the bundle,
// the session, the websocket, the first snapshots and, for the layer table, the query engine -- gets one ceiling here,
// so the assertions after it wait only for what they are about and can keep the default timeout.
const APP_READY_TIMEOUT_MS = 60_000

// scaled by how much longer than chromium's a project's test timeout is, which is how playwright.config.ts gives
// firefox its slower query engine
const CHROMIUM_TEST_TIMEOUT_MS = 60_000

function readyTimeout() {
	return APP_READY_TIMEOUT_MS * Math.max(1, test.info().project.timeout / CHROMIUM_TEST_TIMEOUT_MS)
}

export type ReadyOpts = { signals?: (typeof Readiness.OPTIONAL_SIGNALS)[number][] }

export async function waitReady(page: Page, opts?: ReadyOpts) {
	const timeout = readyTimeout()
	await expect(page.locator('html[data-app-ready]'), 'the app to finish starting').toHaveCount(1, { timeout })
	for (const signal of opts?.signals ?? []) {
		await expect(page.locator(`html[data-ready~="${signal}"]`), `the ${signal} to be ready`).toHaveCount(1, { timeout })
	}
}

export async function gotoReady(page: Page, url: string, opts?: ReadyOpts) {
	await page.goto(url)
	await waitReady(page, opts)
}
