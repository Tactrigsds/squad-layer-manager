import { type Browser, type CDPSession, chromium, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type { AppFixture, TestUser } from '../harness/app-fixture'
import { type Recorder, type Rng, sleep } from './metrics'

// Real dashboards, driven through the real UI. A browser is expensive enough that there are only ever a
// handful of these -- the synthetic fleet is what supplies concurrency -- but they are the only actors that
// pay for rendering, for the layer query worker, and for the round trip a person actually waits on.
//
// Every journey is measured end to end: from the click to whatever the UI shows when the work is done, so a
// regression in the server and a regression in the render both land in the same number.

export type BrowserOptions = {
	app: AppFixture
	recorder: Recorder
	rng: Rng
	signal: AbortSignal
	users: TestUser[]
	// mean gap between one browser's journeys
	journeyIntervalMs: number
	headless: boolean
	// capture a per-page cpu profile, written beside the server's. Off by default: it competes with the app for
	// this machine's cores, which is the thing the run is trying to measure.
	profile: boolean
	outDir: string
}

export type BrowserFleet = {
	open: () => Promise<void>
	run: () => Promise<void>
	close: () => Promise<void>
	// the profiles written, when `profile` asked for them
	artifacts: string[]
}

// A tab switch, which is the most common thing anyone does on the dashboard and the cheapest to get wrong:
// each panel subscribes to its own slice of server state.
const TABS = [/^Queue/, /^Teams/]

export function createBrowserFleet(opts: BrowserOptions): BrowserFleet {
	const pages: { page: Page; user: TestUser; session: CDPSession | null }[] = []
	const artifacts: string[] = []
	let browser: Browser | null = null

	// Everything except the navigations happens on the server dashboard, and one of the navigations leaves the
	// page somewhere else. Without this the journeys after a `goto-filters` all wait 15s for a tab that is not
	// on the filters page and time out, which reads as the app being slow rather than the actor being lost.
	async function onDashboard(page: Page) {
		if (new URL(page.url()).pathname.startsWith('/servers')) return
		await page.getByRole('link', { name: 'Server' }).first().click({ timeout: 15_000 })
		await page.getByRole('tab', { name: /^Queue/ }).waitFor({ timeout: 30_000 })
	}

	// The dashboard's panels are stacked in one grid cell, so whichever tab is selected covers the others and
	// swallows clicks meant for them. A journey that needs the queue panel has to select it, not just be on the
	// page: the tab-switching journey leaves it wherever it landed.
	async function onQueueTab(page: Page) {
		await onDashboard(page)
		const tab = page.getByRole('tab', { name: /^Queue/ })
		if ((await tab.getAttribute('aria-selected')) === 'true') return
		await tab.click({ timeout: 15_000 })
		await tab.and(page.locator('[aria-selected="true"]')).waitFor({ timeout: 15_000 })
	}

	async function journey(page: Page) {
		const { recorder, rng, signal } = opts
		switch (rng.int(6)) {
			case 0:
				return recorder.time('browser:switch-tab', async () => {
					await onDashboard(page)
					const tab = page.getByRole('tab', { name: rng.pick(TABS) })
					await tab.click({ timeout: 15_000 })
					await tab.and(page.locator('[aria-selected="true"]')).waitFor({ timeout: 15_000 })
				})
			case 1:
				return recorder.time('browser:open-add-layers', async () => {
					await onQueueTab(page)
					await page.getByRole('button', { name: 'Start Editing' }).click({ timeout: 15_000 })
					await page.getByRole('button', { name: 'Add Layers' }).click({ timeout: 15_000 })
					const dialog = page.getByRole('dialog', { name: 'Add Layers' })
					// The match count, not the dialog root: the root is a headlessui element that never satisfies a
					// visibility check, and the count is the honest signal anyway -- it appears once the layer query
					// has come back from the wasm engine in the worker, which is the work this journey exists to time.
					await dialog.getByText(/matched layers|No layers matched/).waitFor({ timeout: 30_000 })
					await page.keyboard.press('Escape')
					await dialog.waitFor({ state: 'detached', timeout: 15_000 })
				})
			case 2:
				// Scrolled rather than merely opened: the feed grows for the whole run, and scrolling it is what makes
				// the client render entries it had not yet drawn. Nothing inside carries a role of its own, so there
				// is no per-entry locator to wait on.
				return recorder.time('browser:scroll-activity-feed', async () => {
					await onDashboard(page)
					const feed = page.getByRole('region', { name: 'Server Activity' })
					await feed.waitFor({ timeout: 15_000 })
					await feed.hover({ timeout: 15_000 })
					for (let i = 0; i < 5; i++) await page.mouse.wheel(0, 400)
					await sleep(rng.jitter(300), signal)
				})
			case 3:
				// Through the router, not page.goto: a full reload makes the client refetch and re-parse the whole
				// layer artifact, which a real navigation does not, and which would dominate every number here.
				return recorder.time('browser:nav-filters', async () => {
					await onDashboard(page)
					await page.getByRole('link', { name: 'Filters' }).first().click({ timeout: 15_000 })
					await page.getByRole('listitem').first().waitFor({ timeout: 30_000 })
				})
			case 4:
				return recorder.time('browser:reload-dashboard', async () => {
					await page.goto(opts.app.appUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
					await page.getByRole('tab', { name: /^Queue/ }).waitFor({ timeout: 60_000 })
				})
			default:
				// Reading the match history is the heaviest read a page makes: it joins events, players and squads
				// for a whole match, and the roll loop keeps adding matches to read.
				return recorder.time('browser:read-match-history', async () => {
					await onQueueTab(page)
					await page.getByRole('heading', { name: 'Match History' }).waitFor({ timeout: 15_000 })
					await page.getByRole('row').first().waitFor({ timeout: 15_000 })
					await sleep(rng.jitter(500), signal)
				})
		}
	}

	return {
		artifacts,
		open: async () => {
			browser = await chromium.launch({ headless: opts.headless })
			for (const user of opts.users) {
				const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
				// The react-query devtools render whenever the app is not NODE_ENV=production, and with
				// `initialIsOpen` they render open (see components/providers.tsx). The panel then sits over the
				// dashboard and swallows every click meant for it. A real deployment does not show them; hiding them
				// here is what keeps this measuring the app.
				await context.addInitScript(() => {
					const style = document.createElement('style')
					style.textContent = '.tsqd-parent-container { display: none !important; }'
					document.addEventListener('DOMContentLoaded', () => document.head.append(style))
				})
				const page = await context.newPage()
				await opts.recorder.time('browser:first-load', async () => {
					await page.goto(opts.app.loginUrl(user), { waitUntil: 'domcontentloaded', timeout: 60_000 })
					await page.getByRole('tab', { name: /^Queue/ }).waitFor({ timeout: 60_000 })
				})
				let session: CDPSession | null = null
				if (opts.profile) {
					session = await context.newCDPSession(page)
					await session.send('Profiler.enable')
					await session.send('Profiler.start')
				}
				pages.push({ page, user, session })
			}
		},
		run: async () => {
			await Promise.all(
				pages.map(async ({ page }) => {
					while (!opts.signal.aborted) {
						await journey(page)
						await sleep(opts.rng.jitter(opts.journeyIntervalMs), opts.signal)
					}
				}),
			)
		},
		close: async () => {
			for (const [index, { session }] of pages.entries()) {
				if (session) {
					try {
						const { profile } = await session.send('Profiler.stop')
						const file = path.join(opts.outDir, `browser-${index}.cpuprofile`)
						fs.writeFileSync(file, JSON.stringify(profile))
						artifacts.push(file)
					} catch {
						// a page that died mid-run has no profile to collect, and the run's other artifacts are the point
					}
				}
			}
			await browser?.close()
		},
	}
}
