import * as LTag from '@/models/layer-tags.models'

import { type AppFixture, createAppFixture, type TestUser } from '../harness/app-fixture'
import { LAYERS, layerText, queue, role } from '../harness/arrange'
import { savedQueue } from '../harness/inspect'
import { expect, test } from './fixtures'

// Two people working on the same queue, against one app. Edits are operations broadcast between
// clients and replayed against whatever state each one holds, so this is where an op that isn't
// commutative -- or a client that misses one -- shows up as two people looking at different queues.
// The annotations journey runs first: tags and notes ride the same op pipeline, notes carry an
// ownership rule, and what it saves is the queue the collaborative journey then edits.

const META = { id: LTag.createTagId('meta'), label: 'meta', description: 'Competitive layer', color: '#3b82f6' }
const INFANTRY = { id: LTag.createTagId('inf'), label: 'inf', description: 'Infantry heavy', color: '#22c55e' }

// a second editor: allowed to edit the queue, but holding no queue:manage-all-notes
const WRITER: TestUser = { discordId: 900000000000000031n, username: 'test-writer' }
// and one the save flow says yes to unconditionally
const SECOND_USER: TestUser = { discordId: 900000000000000009n, username: 'test-editor', superUser: true }

const ADMIN_NOTE = 'watch the middle cap, see https://example.com/callouts'
// long enough that the two notes together exceed what the row will hold inline
const WRITER_NOTE = 'disagree, the north route is the faster approach and the middle cap is a trap on this layer'

let app: AppFixture

test.beforeAll(async () => {
	app = await createAppFixture({
		layerQueue: queue(LAYERS.harjuRaas, LAYERS.sumariRaas, LAYERS.skorpoRaas),
		users: [WRITER, SECOND_USER],
		globalSettings: (settings) => {
			settings.layerTags = [META, INFANTRY]
			// site:authorized is what lets the session exist at all; queue:write is what allows notes of
			// their own, and is deliberately not accompanied by queue:manage-all-notes
			settings.rbac.roles['queue-writer'] = role(['site:authorized', 'queue:write'], { users: [WRITER] })
		},
	})
})

test.afterAll(async () => {
	await app?.dispose()
})

test.describe('layer tags and notes', { tag: '@firefox' }, () => {
	test('tagging and annotating an item, and who is allowed to change a note', async ({ page, browser }) => {
		const second = await browser.newContext()
		const pageB = await second.newPage()
		try {
			await page.goto(app.loginUrl())
			await expect(page.getByRole('tab', { name: 'Queue (3)' })).toBeVisible({ timeout: 20_000 })

			const queuePanel = page.getByRole('tabpanel', { name: /^Queue/ })
			const item = queuePanel.getByRole('listitem').filter({ hasText: layerText('Harju_RAAS_v1') })
			await page.getByRole('button', { name: 'Start Editing' }).click()

			// -------- tagging --------
			// the controls stay collapsed until the row is hovered, so every interaction with them hovers first
			for (const tag of [META, INFANTRY]) {
				await item.hover()
				await item.getByRole('button', { name: 'add tag' }).click()
				// a menu entry reads out as its label and description together
				await page.getByRole('menuitem', { name: `${tag.label} ${tag.description}` }).click()
			}
			await expect(item.getByText(META.label, { exact: true })).toBeVisible()
			await expect(item.getByText(INFANTRY.label, { exact: true })).toBeVisible()

			// tags come off one at a time, and taking one off leaves the other alone
			await item.hover()
			await item.getByRole('button', { name: `Remove ${INFANTRY.label}` }).click()
			await expect(item.getByText(INFANTRY.label, { exact: true })).toBeHidden()
			await expect(item.getByText(META.label, { exact: true })).toBeVisible()

			// -------- noting --------
			await item.hover()
			await item.getByRole('button', { name: 'add note' }).click()
			const noteDialog = page.getByRole('dialog', { name: 'Add note' })
			await noteDialog.getByRole('textbox').fill(ADMIN_NOTE)
			await noteDialog.getByRole('button', { name: 'Add' }).click()

			// notes read as "<author>: <text>", and the url in one is a real link
			await expect(item.getByText('test-admin:')).toBeVisible()
			await expect(item.getByRole('link', { name: 'https://example.com/callouts' })).toBeVisible()

			// -------- both survive the save --------
			// the seeded queue repeats the layer that is already playing, so the save asks for a second,
			// deliberate confirmation before it commits
			await page.getByRole('button', { name: /^(Save|Force Save)$/ }).click()
			await expect(page.getByText('Repeats Detected')).toBeVisible()
			await page.getByRole('button', { name: /^(Save Anyway|Force Save)$/ }).click()
			await app.waitFor(
				() => {
					const db = app.readDb()
					try {
						const row = db.prepare(`SELECT layerQueue FROM servers WHERE id = ?`).get(app.serverId) as { layerQueue: string }
						const list = JSON.parse(row.layerQueue).json as { tags?: string[]; notes?: { text: string }[] }[]
						const head = list[0]
						return head?.tags?.length === 1 && head.tags[0] === META.id && head.notes?.[0]?.text === ADMIN_NOTE
					} finally {
						db.close()
					}
				},
				{ label: 'the tag and note saved onto the head item' },
			)

			// -------- a second editor --------
			await pageB.goto(app.loginUrl(WRITER))
			await expect(pageB.getByRole('tab', { name: 'Queue (3)' })).toBeVisible({ timeout: 20_000 })
			const panelB = pageB.getByRole('tabpanel', { name: /^Queue/ })
			const itemB = panelB.getByRole('listitem').filter({ hasText: layerText('Harju_RAAS_v1') })
			await expect(itemB.getByText(META.label, { exact: true })).toBeVisible()

			// the note is someone else's and they hold no manage-all grant, so it offers them nothing to press
			await pageB.getByRole('button', { name: 'Start Editing' }).click()
			await itemB.getByText(ADMIN_NOTE).hover()
			const adminNoteCard = pageB.getByRole('group', { name: 'Note' }).filter({ hasText: ADMIN_NOTE })
			await expect(adminNoteCard).toBeVisible()
			await expect(adminNoteCard.getByRole('button', { name: 'Edit' })).toHaveCount(0)

			// their own note, though, is theirs to change
			await itemB.hover()
			await itemB.getByRole('button', { name: 'Add note' }).click()
			const noteDialogB = pageB.getByRole('dialog', { name: 'Add note' })
			await noteDialogB.getByRole('textbox').fill(WRITER_NOTE)
			await noteDialogB.getByRole('button', { name: 'Add' }).click()

			// two notes now crowd the row, so they collapse behind a count instead of rendering inline
			await itemB.getByRole('button', { name: /View 2 notes/ }).click()
			const ownNoteCard = pageB.getByRole('group', { name: 'Note' }).filter({ hasText: WRITER_NOTE })
			await expect(ownNoteCard.getByRole('button', { name: 'Edit' })).toBeVisible()
			await expect(
				pageB.getByRole('group', { name: 'Note' }).filter({ hasText: ADMIN_NOTE }).getByRole('button', { name: 'Edit' }),
			).toHaveCount(0)

			// commit the writer's note, so their editing session ends cleanly rather than holding a draft
			// into the next test. The seeded repeat is still in the queue, so this save asks too.
			await pageB.getByRole('button', { name: /^(Save|Force Save)$/ }).click()
			await expect(pageB.getByText('Repeats Detected')).toBeVisible()
			await pageB.getByRole('button', { name: /^(Save Anyway|Force Save)$/ }).click()
			await app.waitFor(
				() => {
					const db = app.readDb()
					try {
						const row = db.prepare(`SELECT layerQueue FROM servers WHERE id = ?`).get(app.serverId) as { layerQueue: string }
						const list = JSON.parse(row.layerQueue).json as { notes?: { text: string }[] }[]
						return list[0]?.notes?.length === 2
					} finally {
						db.close()
					}
				},
				{ label: "the writer's note saved beside the admin's" },
			)
		} finally {
			await second.close()
		}
	})
})

test.describe('collaborative queue editing', () => {
	test("one editor sees the other's edits live, and the save commits both", async ({ page, browser }) => {
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
			await panelA
				.getByRole('listitem')
				.filter({ hasText: layerText('Harju_RAAS_v1') })
				.getByRole('button', { name: 'Delete' })
				.click()
			await expect(panelB.getByText('Harju_RAAS_v1')).toBeHidden({ timeout: 15_000 })

			// and B's own edit lands on top of A's, in both clients
			await panelB
				.getByRole('listitem')
				.filter({ hasText: layerText('Skorpo_RAAS_v1') })
				.getByRole('button', { name: 'Delete' })
				.click()
			await expect(panelA.getByText('Skorpo_RAAS_v1')).toBeHidden({ timeout: 15_000 })
			await expect(panelA.getByRole('listitem')).toHaveCount(1)

			// A leaves the session; B, now the only editor, saves what the two of them built
			await page.getByRole('button', { name: 'Finish Editing' }).click()
			await pageB.getByRole('button', { name: 'Save', exact: true }).click()

			// what was saved is what both of them were looking at
			await app.waitFor(
				() => {
					const list = savedQueue(app)
					return list.length === 1 && list[0].layerId === LAYERS.sumariRaas
				},
				{ label: 'the queue both editors were looking at' },
			)

			const setNext = await app.emu.expectCommand(/^AdminSetNextLayer /, { timeoutMs: 20_000 })
			expect(setNext.body).toContain('Sumari_RAAS_v1')
		} finally {
			await second.close()
		}
	})
})
