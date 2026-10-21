import type { Page } from '@playwright/test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import * as AR from '@/app-routes'
import * as LayerArtifacts from '@/systems/layer-artifacts.server'

import { type AppFixture, createAppFixture } from '../harness/app-fixture'
import { expect, test } from './fixtures'
import { settledText } from './settle'

// A deployment moves between layer pools by dropping a new artifact pair into its data directory and restarting.
// Every open tab is pinned to the pool it loaded, and so is the query worker the tabs share, which outlives any
// one of them: a tab that reloads on its own reconnects to the same worker. So the crossing has three parts, and
// this scenario covers all of them against one app: the tabs notice the new pool and reload, the worker they come
// back to rebuilds its engine for it, and the OPFS copy of the artifact follows.
//
// Its own app because the config is the subject: the pool lives in a directory this test swaps out under a
// restart, and the artifact cache is on, which e2e otherwise leaves off.

// two pairs whose layer indexes differ, so the old table read against the new layer data fails rather than passing
const OLD_VERSION = '10.6.0'
const NEW_VERSION = '10.6.2'
const SHIPPED_ARTIFACTS = path.resolve(import.meta.dirname, '../../assets/layers')

// what earlier builds of the cache left in the OPFS root, none of which the current layout reads
const LEGACY_CACHE_ENTRIES = ['layers.sqlite3', 'layers.sqlite3.hash', 'layers.bin', 'layers.bin.hash']
const CACHE_ENTRY = /^layers-[0-9a-f]{64}\.bin$/

let app: AppFixture
let layersDir: string

function installPair(version: string) {
	for (const entry of fs.readdirSync(layersDir)) fs.rmSync(path.join(layersDir, entry))
	const names = [LayerArtifacts.tableFileName(version, { compressed: true }), LayerArtifacts.layerDataFileName(version)]
	for (const name of names) fs.copyFileSync(path.join(SHIPPED_ARTIFACTS, name), path.join(layersDir, name))
}

test.beforeAll(async () => {
	layersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slm-layer-pool-'))
	installPair(OLD_VERSION)
	app = await createAppFixture({ env: { LAYERS_DIR: layersDir, LAYERS_VERSION: '@latest', CACHE_LAYER_ARTIFACT: 'true' } })
})

test.afterAll(async () => {
	await app?.dispose()
	if (layersDir) fs.rmSync(layersDir, { recursive: true, force: true })
})

// the readout of the Add Layers dialog is the one number on screen that the query worker produced. The dialog opens
// on the remembered collection, which leaves out the mod collections the two pools differ by, so it is cleared first;
// the cleared menu is remembered too, so later openings start unpinned.
async function matchedLayers(page: Page) {
	await page.getByRole('button', { name: 'Start Editing' }).click()
	await page.getByRole('button', { name: 'Add Layers' }).click()
	const dialog = page.getByRole('dialog', { name: 'Add Layers' })
	const collection = dialog.getByRole('combobox', { name: 'Collection' })
	await expect(collection).toBeVisible()
	if ((await collection.textContent()) !== 'Select Collection...') {
		await collection.click()
		await page.getByRole('option', { name: '-', exact: true }).click()
		await expect(collection).toHaveText('Select Collection...')
	}
	const text = await settledText(dialog)
	await page.keyboard.press('Escape')
	return text
}

function opfsEntries(page: Page) {
	return page.evaluate(async () => {
		const names: string[] = []
		for await (const name of (await navigator.storage.getDirectory()).keys()) names.push(name)
		return names.sort()
	})
}

test.describe('a new layer pool under open tabs', { tag: '@firefox' }, () => {
	test('reloads every tab, rebuilds the shared engine, and replaces the cached artifact', async ({ page }) => {
		// the login form is on the app's origin but runs none of the app, so the root can be seeded before any
		// worker has looked at it
		await page.goto(`${app.appUrl}/`)
		await page.evaluate(async (names) => {
			const root = await navigator.storage.getDirectory()
			for (const name of names) {
				const writable = await (await root.getFileHandle(name, { create: true })).createWritable()
				await writable.write('left behind by an earlier build')
				await writable.close()
			}
		}, LEGACY_CACHE_ENTRIES)

		const pageB = await page.context().newPage()
		try {
			await Promise.all([page.goto(app.loginUrl()), pageB.goto(app.loginUrl())])

			// four settled readouts at 1.6s of stable reads each, and the two tabs are independent, so they read at once
			const [before, beforeOnB] = await Promise.all([matchedLayers(page), matchedLayers(pageB)])
			expect(before).toMatch(/\d+ matched layers/)
			expect(beforeOnB).toBe(before)

			// one entry, named by the artifact's hash, and the legacy layouts swept
			const cachedBefore = await opfsEntries(page)
			expect(cachedBefore).toHaveLength(1)
			expect(cachedBefore[0]).toMatch(CACHE_ENTRY)

			// the tabs learn of the new pool from the config the server pushes when they reconnect, and reload
			const reloaded = Promise.all([page.waitForEvent('load', { timeout: 90_000 }), pageB.waitForEvent('load', { timeout: 90_000 })])
			await app.restart(() => installPair(NEW_VERSION))
			await reloaded

			// the worker both tabs reconnected to answers for the new pool, and the tabs agree
			const [after, afterOnB] = await Promise.all([matchedLayers(page), matchedLayers(pageB)])
			expect(after).toMatch(/\d+ matched layers/)
			expect(after).not.toBe(before)
			expect(afterOnB).toBe(after)

			const cachedAfter = await opfsEntries(page)
			expect(cachedAfter).toHaveLength(1)
			expect(cachedAfter[0]).toMatch(CACHE_ENTRY)
			expect(cachedAfter[0]).not.toBe(cachedBefore[0])
		} finally {
			await pageB.close()
		}
	})

	// A cache in front of the app, such as a CDN, can keep answering with the table from before the swap. The worker's
	// first request is sent before the page has named its layer data, so that request can get the stale table.
	test('refetches a table that pairs with other layer data', async ({ browser }) => {
		const sha256 = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex')
		const staleTable = fs.readFileSync(path.join(SHIPPED_ARTIFACTS, LayerArtifacts.tableFileName(OLD_VERSION, { compressed: true })))
		const staleLayerData = fs.readFileSync(path.join(SHIPPED_ARTIFACTS, LayerArtifacts.layerDataFileName(OLD_VERSION)), 'utf8')
		// the server hashes the file re-serialized without indentation (see layer-data.server.ts)
		const staleLayerDataHash = sha256(Buffer.from(JSON.stringify(JSON.parse(staleLayerData))))

		// a fresh context, so no worker or cached table carries over from the test before. Routing does not reach a
		// shared worker's requests, so the page falls back to the dedicated worker, which runs the same code.
		const context = await browser.newContext()
		await context.addInitScript(() => {
			delete (window as { SharedWorker?: unknown }).SharedWorker
		})
		try {
			let staleServed = 0
			await context.route(/\/layers\.bin\.gz$/, (route) => {
				staleServed++
				return route.fulfill({
					status: 200,
					body: staleTable,
					headers: {
						'Content-Type': 'application/gzip',
						ETag: `"${sha256(staleTable)}"`,
						[AR.LAYER_DATA_HASH_HEADER]: staleLayerDataHash,
					},
				})
			})
			const page = await context.newPage()
			await page.goto(app.loginUrl())
			expect(await matchedLayers(page)).toMatch(/\d+ matched layers/)
			expect(staleServed).toBe(1)
		} finally {
			await context.close()
		}
	})
})
