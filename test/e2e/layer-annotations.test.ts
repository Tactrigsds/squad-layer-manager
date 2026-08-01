import * as LTag from '@/models/layer-tags.models'

import { createAppFixture, type TestUser } from '../harness/app-fixture'
import { LAYERS, queue } from '../harness/arrange'
import { expect, test } from './fixtures'

// Tags and notes are the two annotations a queue item carries. Neither is written directly: both ride
// through the operation pipeline and only reach the database on save, so this covers the path where an
// annotation could be shown to whoever made it and then quietly not survive the commit. A note also
// belongs to its author, which is the rule that would rot silently if the ownership check came adrift.

const META = { id: LTag.createTagId('meta'), label: 'meta', description: 'Competitive layer', color: '#3b82f6' }
const INFANTRY = { id: LTag.createTagId('inf'), label: 'inf', description: 'Infantry heavy', color: '#22c55e' }

// a second editor: allowed to edit the queue, but holding no queue:manage-all-notes
const WRITER: TestUser = { discordId: 900000000000000031n, username: 'test-writer' }

const ADMIN_NOTE = 'watch the middle cap, see https://example.com/callouts'
// long enough that the two notes together exceed what the row will hold inline
const WRITER_NOTE = 'disagree, the north route is the faster approach and the middle cap is a trap on this layer'

test.describe('layer tags and notes', { tag: '@firefox' }, () => {
	test('tagging and annotating an item, and who is allowed to change a note', async ({ page, browser }) => {
		const app = await createAppFixture({
			layerQueue: queue(LAYERS.harjuRaas, LAYERS.sumariRaas),
			users: [WRITER],
			globalSettings: (settings) => {
				settings.layerTags = [META, INFANTRY]
				settings.rbac.roles['queue-writer'] = {
					// site:authorized is what lets the session exist at all; queue:write is what allows notes of
					// their own, and is deliberately not accompanied by queue:manage-all-notes
					permissions: ['site:authorized', 'queue:write'],
					globalSettingsGrants: [],
					serverSettingsGrants: [],
					serverGrants: [],
					assignments: {
						discordRoleIds: [],
						discordUserIds: [String(WRITER.discordId)],
						everyMember: false,
						ingameAdminLists: [],
						adminListGroups: [],
					},
				}
			},
		})
		const second = await browser.newContext()
		const pageB = await second.newPage()
		try {
			await page.goto(app.loginUrl())
			await expect(page.getByRole('tab', { name: 'Queue (2)' })).toBeVisible({ timeout: 20_000 })

			const queuePanel = page.getByRole('tabpanel', { name: /^Queue/ })
			const item = queuePanel.getByRole('listitem').filter({ hasText: 'Harju_RAAS_v1' })
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
			// deliberate confirmation before it commits (see queue-editing.test.ts)
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
			await expect(pageB.getByRole('tab', { name: 'Queue (2)' })).toBeVisible({ timeout: 20_000 })
			const panelB = pageB.getByRole('tabpanel', { name: /^Queue/ })
			const itemB = panelB.getByRole('listitem').filter({ hasText: 'Harju_RAAS_v1' })
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
		} finally {
			await second.close()
			await app.dispose()
		}
	})
})
