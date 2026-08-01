import { makePlayer } from '@/emulator'
import * as BB from '@/models/backburner.models'
import * as FB from '@/models/filter-builders'
import * as L from '@/models/layer'

import { ADMIN_USER, type AppFixture, createAppFixture } from '../harness/app-fixture'
import { cmd, filter, LAYERS, queue } from '../harness/arrange'
import { belowItem, centerOf, dragFrom } from '../harness/drag'
import { expect, test } from './fixtures'

// The backburner panel below the queue: requests arriving from chat show up live, GUI edits are draft
// state committed by the queue's save flow, and requests move between the panel and the queue by drag.
// Three apps carry the file -- the dialog-driven tests, the picker drags, and the pinned-template drags --
// grouped so every locator stays unambiguous while the requests it targets are consumed.

const ADMIN_STEAM_ID = '76561198000000001'

function savedBackburner(app: AppFixture): { itemId: string }[] {
	const db = app.readDb()
	try {
		const row = db.prepare(`SELECT backburner FROM servers WHERE id = ?`).get(app.serverId) as { backburner: string }
		return JSON.parse(row.backburner).json
	} finally {
		db.close()
	}
}

test.describe('requests from chat and the edit dialog', { tag: '@firefox' }, () => {
	let app: AppFixture

	test.beforeAll(async () => {
		app = await createAppFixture({
			layerQueue: queue(LAYERS.gorodokRaas),
			admins: [ADMIN_STEAM_ID],
			adminSteamIds: [ADMIN_STEAM_ID],
			// neither seeded map collides with the Fallujah request the chat test makes, so every row
			// locator in this describe stays unambiguous whether or not the dialog's Apply was committed
			backburner: [
				{
					itemId: 'req-narva',
					filter: FB.and([FB.eq('Map', 'Narva')]),
					source: { discordId: ADMIN_USER.discordId },
					createdAt: 1000,
				},
				{
					itemId: 'req-skorpo',
					filter: FB.and([FB.eq('Map', 'Skorpo')]),
					source: { discordId: ADMIN_USER.discordId },
					createdAt: 2000,
				},
			],
			serverSettings: (s) => {
				s.queue.mainPool.repeatRules = []
			},
		})
	})

	test.afterAll(async () => {
		await app?.dispose()
	})

	test('the request dialog is seeded from the request being edited, and applies the change', async ({ page }) => {
		await page.goto(app.loginUrl())
		const panel = page.getByRole('tabpanel', { name: /^Queue/ })
		await expect(panel.getByText('Layer Requests (2)')).toBeVisible({ timeout: 20_000 })

		await panel.getByRole('listitem').filter({ hasText: 'Narva' }).getByRole('button', { name: 'Edit request' }).click()
		const dialog = page.getByRole('dialog', { name: 'Edit layer request' })
		const mapField = dialog.getByRole('combobox', { name: 'Map' })
		// the form is built from the request whose pencil was clicked
		await expect(mapField).toHaveText('Narva')

		await mapField.click()
		await page.getByRole('option', { name: 'Sumari', exact: true }).click()
		await expect(mapField).toHaveText('Sumari')
		await dialog.getByRole('button', { name: 'Apply' }).click()

		await expect(panel.getByRole('listitem').filter({ hasText: 'Sumari' })).toHaveCount(1)
		await expect(panel.getByRole('listitem').filter({ hasText: 'Narva' })).toHaveCount(0)

		// the next request opens on its own template rather than on the one the dialog last held
		await panel.getByRole('listitem').filter({ hasText: 'Skorpo' }).getByRole('button', { name: 'Edit request' }).click()
		await expect(dialog.getByRole('combobox', { name: 'Map' })).toHaveText('Skorpo')
	})

	test('shows chat requests live and removes one through the draft/save flow', async ({ page }) => {
		const admin = app.emu.world.connectPlayer(makePlayer({ name: ' test_admin_player', steam: ADMIN_STEAM_ID }))
		await app.waitForRosterSync()

		await page.goto(app.loginUrl())
		await expect(page.getByRole('tab', { name: 'Queue (1)' })).toBeVisible({ timeout: 20_000 })

		// a request arriving from chat shows up in the panel without a reload
		app.emu.world.chat(admin, 'ChatAdmin', cmd('reqlayer fallu'))
		const panel = page.getByRole('tabpanel', { name: /^Queue/ })
		await expect(panel.getByText('Layer Requests (3)')).toBeVisible({ timeout: 20_000 })
		const row = panel.getByRole('listitem').filter({ hasText: 'Fallujah' })
		await expect(row).toBeVisible()

		// removing it is a draft edit: the row disappears locally, the saved list is untouched until save
		await row.getByRole('button').last().click()
		await expect(panel.getByText('Layer Requests (2)')).toBeVisible()
		expect(savedBackburner(app)).toHaveLength(3)

		// only backburner changes are pending, so the panel offers its own save
		await panel.getByRole('button', { name: 'Save', exact: true }).click()
		await app.waitFor(() => (savedBackburner(app).length === 2 ? true : null), {
			label: 'the removal being saved',
			timeoutMs: 20_000,
		})
	})
})

test.describe('dragging requests onto the queue', { tag: '@firefox' }, () => {
	let app: AppFixture

	test.beforeAll(async () => {
		app = await createAppFixture({
			layerQueue: queue(LAYERS.gorodokRaas),
			filters: [filter('raas-only', 'RAAS Only', FB.and([FB.eq('Gamemode', 'RAAS')]))],
			backburner: [
				{
					itemId: 'req-regular',
					filter: FB.and([FB.eq('Map', 'Gorodok'), FB.includedIn('raas-only')]),
					source: { discordId: ADMIN_USER.discordId },
					createdAt: 1000,
				},
				{
					itemId: 'req-inverted',
					filter: FB.and([FB.eq('Map', 'Fallujah'), FB.excludedFrom('raas-only')]),
					source: { discordId: ADMIN_USER.discordId },
					createdAt: 2000,
				},
				{
					itemId: 'req-sumari',
					// mod sources reuse the Sumari map name; the collection term keeps the dialog's table on the
					// vanilla layers the assertions below pick from
					filter: FB.and([
						FB.eq('Map', 'Sumari'),
						FB.eq('Collection', 'OWI'),
						FB.allowMatchups([{ Faction: ['USA'] }, { Faction: ['RGF'] }]),
					]),
					source: { discordId: ADMIN_USER.discordId },
					createdAt: 3000,
				},
			],
			serverSettings: (s) => {
				s.queue.mainPool.repeatRules = []
			},
		})
	})

	test.afterAll(async () => {
		await app?.dispose()
	})

	test('drag-combining requests with conflicting filters is rejected with a toast', async ({ page }) => {
		await page.goto(app.loginUrl())
		const panel = page.getByRole('tabpanel', { name: /^Queue/ })
		await expect(panel.getByText('Layer Requests (3)')).toBeVisible({ timeout: 20_000 })
		const regularRow = panel.getByRole('listitem').filter({ hasText: 'RAAS Only' }).filter({ hasText: 'Gorodok' })
		const invertedRow = panel.getByRole('listitem').filter({ hasText: 'not RAAS Only' })
		await expect(regularRow).toBeVisible()
		await expect(invertedRow).toBeVisible()

		// drag the inverted request onto the regular one: same filter applied both ways must not merge
		await dragFrom(page, invertedRow.getByRole('button').first(), () => centerOf(regularRow))

		await expect(page.getByText('Cannot combine these requests')).toBeVisible({ timeout: 5_000 })
		await expect(panel.getByText('Layer Requests (3)')).toBeVisible()
	})

	test('dragging a request onto the queue opens the Select Layers dialog seeded from its template', async ({ page }) => {
		await page.goto(app.loginUrl())
		const panel = page.getByRole('tabpanel', { name: /^Queue/ })
		await expect(panel.getByText('Layer Requests (3)')).toBeVisible({ timeout: 20_000 })
		const requestRow = panel.getByRole('listitem').filter({ hasText: 'Sumari' })
		await expect(requestRow).toBeVisible()

		// dragging a request expands the queue's drop separators into an easy target without the user
		// having to start editing the queue first
		const queueItem = panel.getByRole('listitem').filter({ hasText: 'Gorodok_RAAS_v1' }).first()
		await expect(queueItem).toBeVisible()

		// drag the request's grip onto the separator just below the first queue item
		await dragFrom(page, requestRow.getByRole('button').first(), () => belowItem(queueItem))

		// the dialog opens seeded from the template (its headlessui root never reports visible, so assert on
		// content): matchup left -> Team 1 (_1), right -> Team 2 (_2). Seeding those fields is a layer query,
		// so none of these carry an inline timeout: firefox is slow enough at one to blow a ceiling chromium
		// never comes near (see the firefox project in playwright.config.ts).
		const dialog = page.getByRole('dialog', { name: 'Add requested layer' })
		await expect(dialog.getByRole('combobox', { name: 'Map' })).toHaveText('Sumari')

		// pick a concrete Sumari layer and add it; the request is consumed
		const layerRow = dialog.getByRole('row').filter({ hasText: 'Sumari_RAAS_v1' }).first()
		await expect(layerRow).toBeVisible()
		await layerRow.click()
		await dialog.getByRole('button', { name: 'Submit' }).click()

		// exactly one layer is added (guards against a double-dispatch), and the request is consumed
		await expect(panel.getByRole('listitem').filter({ hasText: 'Sumari_RAAS_v1' })).toHaveCount(1)
		await expect(panel.getByText('Layer Requests (2)')).toBeVisible()
	})
})

test.describe('pinned templates and moving queue items out', { tag: '@firefox' }, () => {
	let app: AppFixture

	test.beforeAll(async () => {
		app = await createAppFixture({
			layerQueue: queue(LAYERS.gorodokRaas),
			backburner: [
				{
					itemId: 'req-sumari-seed',
					filter: BB.templateFromLayer(L.toLayer(LAYERS.sumariSeed)),
					source: { discordId: ADMIN_USER.discordId },
					createdAt: 1000,
				},
			],
			serverSettings: (s) => {
				s.queue.mainPool.repeatRules = []
			},
		})
	})

	test.afterAll(async () => {
		await app?.dispose()
	})

	test('a request that only one layer satisfies is added straight to the queue, no picker', async ({ page }) => {
		await page.goto(app.loginUrl())
		const panel = page.getByRole('tabpanel', { name: /^Queue/ })
		await expect(panel.getByText('Layer Requests (1)')).toBeVisible({ timeout: 20_000 })

		const requestRow = panel.getByRole('listitem').filter({ hasText: 'Sumari' })
		const queueItem = panel.getByRole('listitem').filter({ hasText: 'Gorodok' }).first()
		await dragFrom(page, requestRow.getByRole('button').first(), () => belowItem(queueItem))

		// the template pins map, gamemode, version and both sides of the matchup, so there is nothing left to
		// pick: the layer lands in the queue and the request is consumed without the Select Layers dialog
		await expect(panel.getByRole('listitem').filter({ hasText: 'Sumari_Seed_v1' })).toHaveCount(1, { timeout: 10_000 })
		await expect(panel.getByText('Layer Requests (0)')).toBeVisible()
		await expect(page.getByRole('dialog', { name: 'Add requested layer' })).toHaveCount(0)
	})

	test('dragging a queue item onto the requests panel moves it into a request', async ({ page }) => {
		await page.goto(app.loginUrl())
		const panel = page.getByRole('tabpanel', { name: /^Queue/ })
		// the drop in the previous test was draft state, which may or may not have outlived that page's
		// editing session: read the starting counts rather than assuming them
		const requestsHeader = panel.getByText(/Layer Requests \(\d+\)/)
		await expect(requestsHeader).toBeVisible({ timeout: 20_000 })
		const queueTab = page.getByRole('tab', { name: /^Queue \(\d+\)/ })
		await expect(queueTab).toBeVisible()
		const requestCount = Number(/\((\d+)\)/.exec((await requestsHeader.textContent())!)![1])
		const queueCount = Number(/\((\d+)\)/.exec((await queueTab.textContent())!)![1])

		const queueItem = panel.getByRole('listitem').filter({ hasText: 'Gorodok' }).first()
		await expect(queueItem).toBeVisible()
		// drop onto the requests panel, whose drop zone covers the whole card
		await dragFrom(page, queueItem.getByRole('button').first(), () => centerOf(requestsHeader, 40))

		// the layer moves out of the queue and into a request: it's gone from the queue and Gorodok now shows
		// exactly once (the request), not twice
		await expect(panel.getByText(`Layer Requests (${requestCount + 1})`)).toBeVisible({ timeout: 10_000 })
		await expect(page.getByRole('tab', { name: `Queue (${queueCount - 1})` })).toBeVisible()
		await expect(panel.getByRole('listitem').filter({ hasText: 'Gorodok' })).toHaveCount(1)
	})
})
