import { createAppFixture, type TestUser } from '../harness/app-fixture'
import { LAYERS, queue } from '../harness/arrange'
import { expect, test } from './fixtures'

// Two people editing the same queue. Edits are operations broadcast between clients and replayed
// against whatever state each one holds, so this is where an op that isn't commutative -- or a
// client that misses one -- shows up as two people looking at different queues.

const SECOND_USER: TestUser = { discordId: 900000000000000009n, username: 'test-editor', superUser: true }

test.describe('collaborative queue editing', () => {
	test("one editor sees the other's edits live, and the save commits both", async ({ page, browser }) => {
		const app = await createAppFixture({
			users: [SECOND_USER],
			layerQueue: queue(LAYERS.gorodokRaas, LAYERS.sumariSeed, LAYERS.skorpoRaas),
		})
		const second = await browser.newContext()
		const pageB = await second.newPage()
		try {
			// A is the seeded admin, B is a second user, both on the same server's dashboard
			await page.goto(app.loginUrl())
			await pageB.goto(app.loginUrl(SECOND_USER))
			for (const p of [page, pageB]) {
				await expect(p.getByRole('tab', { name: 'Queue (3)' })).toBeVisible({ timeout: 25_000 })
			}

			const panelA = page.getByRole('tabpanel', { name: /^Queue/ })
			const panelB = pageB.getByRole('tabpanel', { name: /^Queue/ })

			await page.getByRole('button', { name: 'Start Editing' }).click()
			await pageB.getByRole('button', { name: 'Start Editing' }).click()

			// A deletes the head; B is looking at the same session, so B sees it go
			await panelA.getByRole('listitem').filter({ hasText: 'Gorodok_RAAS_v1' })
				.getByRole('button', { name: 'Delete' }).click()
			await expect(panelB.getByText('Gorodok_RAAS_v1')).toBeHidden({ timeout: 15_000 })

			// and B's own edit lands on top of A's, in both clients
			await panelB.getByRole('listitem').filter({ hasText: 'Skorpo_RAAS_v1' })
				.getByRole('button', { name: 'Delete' }).click()
			await expect(panelA.getByText('Skorpo_RAAS_v1')).toBeHidden({ timeout: 15_000 })
			await expect(panelA.getByRole('listitem')).toHaveCount(1)

			// A leaves the session; B, now the only editor, saves what the two of them built
			await page.getByRole('button', { name: 'Finish Editing' }).click()
			await pageB.getByRole('button', { name: 'Save', exact: true }).click()

			// what was saved is what both of them were looking at
			await app.waitFor(() => {
				const db = app.readDb()
				try {
					const row = db.prepare(`SELECT layerQueue FROM servers WHERE id = ?`).get(app.serverId) as { layerQueue: string }
					const list = JSON.parse(row.layerQueue).json as { layerId: string }[]
					return list.length === 1 && list[0].layerId === LAYERS.sumariSeed
				} finally {
					db.close()
				}
			}, { label: 'the queue both editors were looking at' })

			const setNext = await app.emu.expectCommand(/^AdminSetNextLayer /, { timeoutMs: 20_000 })
			expect(setNext.body).toContain('Sumari_Seed_v1')
		} finally {
			await second.close()
			await app.dispose()
		}
	})
})
