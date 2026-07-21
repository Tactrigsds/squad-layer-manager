import { makePlayer } from '@/emulator'
import * as BB from '@/models/backburner.models'
import * as FB from '@/models/filter-builders'
import * as L from '@/models/layer'
import { ADMIN_USER, createAppFixture } from '../harness/app-fixture'
import { filter, LAYERS, queue } from '../harness/arrange'
import { expect, test } from './fixtures'

// The backburner panel below the queue: requests arriving from chat show up live, and GUI edits are
// draft state committed by the queue's save flow.

const ADMIN_STEAM_ID = '76561198000000001'

test.describe('layer requests panel', () => {
	test('shows chat requests live and removes one through the draft/save flow', async ({ page }) => {
		const app = await createAppFixture({
			layerQueue: queue(LAYERS.gorodokRaas),
			admins: [ADMIN_STEAM_ID],
			adminSteamIds: [ADMIN_STEAM_ID],
			serverSettings: (s) => {
				s.queue.mainPool.repeatRules = []
			},
		})
		const admin = app.emu.world.connectPlayer(makePlayer({ name: ' test_admin_player', steam: ADMIN_STEAM_ID }))
		await app.waitForRosterSync()

		function savedBackburner(): { itemId: string }[] {
			const db = app.readDb()
			try {
				const row = db.prepare(`SELECT backburner FROM servers WHERE id = ?`).get(app.serverId) as { backburner: string }
				return JSON.parse(row.backburner).json
			} finally {
				db.close()
			}
		}

		try {
			await page.goto(app.loginUrl())
			await expect(page.getByRole('tab', { name: 'Queue (1)' })).toBeVisible({ timeout: 20_000 })

			// a request arriving from chat shows up in the panel without a reload
			app.emu.world.chat(admin, 'ChatAdmin', '!reqlayer fallu')
			const panel = page.getByRole('tabpanel', { name: /^Queue/ })
			await expect(panel.getByText('Layer Requests (1)')).toBeVisible({ timeout: 20_000 })
			const row = panel.getByRole('listitem').filter({ hasText: 'Fallujah' })
			await expect(row).toBeVisible()

			// removing it is a draft edit: the row disappears locally, the saved list is untouched until save
			await row.getByRole('button').last().click()
			await expect(panel.getByText('Layer Requests (0)')).toBeVisible()
			expect(savedBackburner()).toHaveLength(1)

			// only backburner changes are pending, so the panel offers its own save
			await panel.getByRole('button', { name: 'Save', exact: true }).click()
			await app.waitFor(() => (savedBackburner().length === 0 ? true : null), {
				label: 'the removal being saved',
				timeoutMs: 20_000,
			})
		} finally {
			await app.dispose()
		}
	})

	test('drag-combining requests with conflicting filters is rejected with a toast', async ({ page }) => {
		const app = await createAppFixture({
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
			],
			serverSettings: (s) => {
				s.queue.mainPool.repeatRules = []
			},
		})
		try {
			await page.goto(app.loginUrl())
			const panel = page.getByRole('tabpanel', { name: /^Queue/ })
			await expect(panel.getByText('Layer Requests (2)')).toBeVisible({ timeout: 20_000 })
			const regularRow = panel.getByRole('listitem').filter({ hasText: 'RAAS Only' }).filter({ hasText: 'Gorodok' })
			const invertedRow = panel.getByRole('listitem').filter({ hasText: 'not RAAS Only' })
			await expect(regularRow).toBeVisible()
			await expect(invertedRow).toBeVisible()

			// drag the inverted request onto the regular one: same filter applied both ways must not merge
			await invertedRow.getByRole('button').first().hover()
			await page.mouse.down()
			// a first small move starts the drag (and expands the drop targets); then re-measure the target
			await page.mouse.move(300, 300, { steps: 5 })
			const target = await regularRow.boundingBox()
			if (!target) throw new Error('target row not visible')
			await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 })
			await page.mouse.up()

			await expect(page.getByText('Cannot combine these requests')).toBeVisible({ timeout: 5_000 })
			await expect(panel.getByText('Layer Requests (2)')).toBeVisible()
		} finally {
			await app.dispose()
		}
	})

	test('dragging a request onto the queue opens the Select Layers dialog seeded from its template', async ({ page }) => {
		const app = await createAppFixture({
			layerQueue: queue(LAYERS.gorodokRaas),
			backburner: [
				{
					itemId: 'req-sumari',
					filter: FB.and([FB.eq('Map', 'Sumari'), FB.allowMatchups([{ Faction: ['USA'] }, { Faction: ['RGF'] }])]),
					source: { discordId: ADMIN_USER.discordId },
					createdAt: 1000,
				},
			],
			serverSettings: (s) => {
				s.queue.mainPool.repeatRules = []
			},
		})
		try {
			await page.goto(app.loginUrl())
			const panel = page.getByRole('tabpanel', { name: /^Queue/ })
			await expect(panel.getByText('Layer Requests (1)')).toBeVisible({ timeout: 20_000 })
			const requestRow = panel.getByRole('listitem').filter({ hasText: 'Sumari' })
			await expect(requestRow).toBeVisible()

			// dragging a request expands the queue's drop separators into an easy target without the user
			// having to start editing the queue first
			const queueItem = panel.getByRole('listitem').filter({ hasText: 'Gorodok' }).first()
			await expect(queueItem).toBeVisible()

			// drag the request's grip onto the separator just below the first queue item
			const grip = requestRow.getByRole('button').first()
			const gripBox = await grip.boundingBox()
			if (!gripBox) throw new Error('grip not visible')
			await grip.hover()
			await page.mouse.down()
			await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y - 20, { steps: 4 })
			const box = await queueItem.boundingBox()
			if (!box) throw new Error('queue item not visible')
			await page.mouse.move(box.x + box.width / 2, box.y + box.height + 8, { steps: 20 })
			await page.mouse.up()

			// the dialog opens seeded from the template (its headlessui root never reports visible, so assert on
			// content): matchup left -> Team 1 (_1), right -> Team 2 (_2)
			const dialog = page.getByRole('dialog', { name: 'Add requested layer' })
			await expect(dialog.getByRole('combobox', { name: 'Map' })).toHaveText('Sumari', { timeout: 10_000 })

			// pick a concrete Sumari layer and add it; the request is consumed
			const layerRow = dialog.getByRole('row').filter({ hasText: 'Sumari_RAAS_v1' }).first()
			await expect(layerRow).toBeVisible()
			await layerRow.click()
			await dialog.getByRole('button', { name: 'Submit' }).click()

			// exactly one layer is added (guards against a double-dispatch), and the request is consumed
			await expect(panel.getByRole('listitem').filter({ hasText: 'Sumari_RAAS_v1' })).toHaveCount(1)
			await expect(panel.getByText('Layer Requests (0)')).toBeVisible()
		} finally {
			await app.dispose()
		}
	})

	test('dragging a queue item onto the requests panel moves it into a request', async ({ page }) => {
		const app = await createAppFixture({
			layerQueue: queue(LAYERS.gorodokRaas),
			serverSettings: (s) => {
				s.queue.mainPool.repeatRules = []
			},
		})
		try {
			await page.goto(app.loginUrl())
			const panel = page.getByRole('tabpanel', { name: /^Queue/ })
			await expect(panel.getByText('Layer Requests (0)')).toBeVisible({ timeout: 20_000 })

			const queueItem = panel.getByRole('listitem').filter({ hasText: 'Gorodok' }).first()
			const grip = queueItem.getByRole('button').first()
			const gripBox = await grip.boundingBox()
			if (!gripBox) throw new Error('queue grip not visible')

			await grip.hover()
			await page.mouse.down()
			await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + 20, { steps: 4 })
			// drop onto the (empty) requests panel, whose drop zone covers the whole card
			const requestsPanel = panel.getByText('Layer Requests (0)')
			const target = await requestsPanel.boundingBox()
			if (!target) throw new Error('requests panel not visible')
			await page.mouse.move(target.x + target.width / 2, target.y + 40, { steps: 20 })
			await page.mouse.up()

			// the layer moves out of the queue and into a request: it's gone from the queue and Gorodok now shows
			// exactly once (the request), not twice
			await expect(panel.getByText('Layer Requests (1)')).toBeVisible({ timeout: 10_000 })
			await expect(page.getByRole('tab', { name: 'Queue (0)' })).toBeVisible()
			await expect(panel.getByRole('listitem').filter({ hasText: 'Gorodok' })).toHaveCount(1)
		} finally {
			await app.dispose()
		}
	})

	test('a request that only one layer satisfies is added straight to the queue, no picker', async ({ page }) => {
		const app = await createAppFixture({
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
		try {
			await page.goto(app.loginUrl())
			const panel = page.getByRole('tabpanel', { name: /^Queue/ })
			await expect(panel.getByText('Layer Requests (1)')).toBeVisible({ timeout: 20_000 })

			const requestRow = panel.getByRole('listitem').filter({ hasText: 'Sumari' })
			const queueItem = panel.getByRole('listitem').filter({ hasText: 'Gorodok' }).first()
			const grip = requestRow.getByRole('button').first()
			const gripBox = await grip.boundingBox()
			if (!gripBox) throw new Error('grip not visible')
			await grip.hover()
			await page.mouse.down()
			await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y - 20, { steps: 4 })
			const box = await queueItem.boundingBox()
			if (!box) throw new Error('queue item not visible')
			await page.mouse.move(box.x + box.width / 2, box.y + box.height + 8, { steps: 20 })
			await page.mouse.up()

			// the template pins map, gamemode, version and both sides of the matchup, so there is nothing left to
			// pick: the layer lands in the queue and the request is consumed without the Select Layers dialog
			await expect(panel.getByRole('listitem').filter({ hasText: 'Sumari_Seed_v1' })).toHaveCount(1, { timeout: 10_000 })
			await expect(panel.getByText('Layer Requests (0)')).toBeVisible()
			await expect(page.getByRole('dialog', { name: 'Add requested layer' })).toHaveCount(0)
		} finally {
			await app.dispose()
		}
	})
})
