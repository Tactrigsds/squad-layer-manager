import type { Page } from '@playwright/test'
import * as fsp from 'node:fs/promises'

import * as FB from '@/models/filter-builders.models'
import * as LTag from '@/models/layer-tags.models'

import { type AppFixture, createAppFixture, type TestUser } from '../harness/app-fixture'
import { filter, LAYERS, layerText, queue, role, rotation } from '../harness/arrange'
import * as Dash from '../harness/dashboard'
import { savedQueue, savedRotation } from '../harness/inspect'
import { expect, test } from './fixtures'

// Two people working on the same queue, against one app. Edits are operations broadcast between
// clients and replayed against whatever state each one holds, so this is where an op that isn't
// commutative -- or a client that misses one -- shows up as two people looking at different queues.
// The annotations journey runs first: tags and notes ride the same op pipeline, notes carry an
// ownership rule, and what it saves is the queue the collaborative journey then edits. A rotation's items are
// edited with the same list editor and ops, so the rotation journeys share this app. Only the last of them touches the
// queue, replacing it with a rotation.

const META = { id: LTag.createTagId('meta'), label: 'meta', description: 'Competitive layer', color: '#3b82f6' }
const INFANTRY = { id: LTag.createTagId('inf'), label: 'inf', description: 'Infantry heavy', color: '#22c55e' }

// a second editor: allowed to edit the queue, but holding no queue:manage-all-notes
const WRITER: TestUser = { discordId: 900000000000000031n, username: 'test-writer' }
// and one the save flow says yes to unconditionally
const SECOND_USER: TestUser = { discordId: 900000000000000009n, username: 'test-editor', superUser: true }

const ADMIN_NOTE = 'watch the middle cap, see https://example.com/callouts'
// long enough to clamp on the row, so the card is the only place it reads in full
const WRITER_NOTE = 'disagree, the north route is the faster approach and the middle cap is a trap on this layer'

let app: AppFixture

test.beforeAll(async () => {
	app = await createAppFixture({
		layerQueue: queue(LAYERS.harjuRaas, LAYERS.sumariRaas, LAYERS.skorpoRaas),
		rotations: [
			rotation('weekend', 'Weekend Competitive', queue(LAYERS.gorodokRaas, LAYERS.narvaRaas), { description: 'Saturday night set' }),
			rotation('midweek', 'Midweek Casual', queue(LAYERS.sumariRaas)),
		],
		// an extra filter for the pickers' applied filters, which no pool references
		filters: [filter('narva-only', 'Narva Only', FB.eq('Map', 'Narva'))],
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
			await expect(Dash.queueLabel(page, 'Queue (3)')).toBeVisible({ timeout: 20_000 })

			const queuePanel = Dash.queueSection(page)
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
			await expect(Dash.queueLabel(pageB, 'Queue (3)')).toBeVisible({ timeout: 20_000 })
			const panelB = Dash.queueSection(pageB)
			const itemB = panelB.getByRole('listitem').filter({ hasText: layerText('Harju_RAAS_v1') })
			await expect(itemB.getByText(META.label, { exact: true })).toBeVisible()

			// the note is someone else's and they hold no manage-all grant, so it offers them nothing to press
			await pageB.getByRole('button', { name: 'Start Editing' }).click()
			const adminNoteCard = pageB.getByRole('group', { name: 'Note' }).filter({ hasText: ADMIN_NOTE })
			// the item re-renders into edit mode, which can swallow a hover landing mid-way; leaving and re-entering
			// is the only thing that opens the card again
			await expect(async () => {
				await pageB.mouse.move(0, 0)
				await itemB.getByText(ADMIN_NOTE).hover()
				await expect(adminNoteCard).toBeVisible({ timeout: 2_000 })
			}).toPass()
			await expect(adminNoteCard.getByRole('button', { name: 'Edit' })).toHaveCount(0)

			// their own note, though, is theirs to change
			await itemB.hover()
			await itemB.getByRole('button', { name: 'Add note' }).click()
			const noteDialogB = pageB.getByRole('dialog', { name: 'Add note' })
			await noteDialogB.getByRole('textbox').fill(WRITER_NOTE)
			await noteDialogB.getByRole('button', { name: 'Add' }).click()

			// both notes sit on the row, the newest first; their own carries the edit button
			const noteRow = itemB.getByText(WRITER_NOTE)
			await expect(noteRow).toBeVisible()
			await noteRow.hover()
			const ownNoteCard = pageB.getByRole('group', { name: 'Note' }).filter({ hasText: WRITER_NOTE })
			await expect(ownNoteCard.getByRole('button', { name: 'Edit' })).toBeVisible()

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

// two tabs in one browser context ride a single SharedWorker query engine; a routing or second-init
// regression shows up as the second tab's queries hanging or erroring
test.describe('shared query engine', () => {
	test('a second tab in the same session gets a working layer table', async ({ page }) => {
		const pageB = await page.context().newPage()
		try {
			await page.goto(app.loginUrl())
			await expect(Dash.queueLabel(page, /^Queue/)).toBeVisible({ timeout: 25_000 })
			await pageB.goto(app.loginUrl())
			await expect(Dash.queueLabel(pageB, /^Queue/)).toBeVisible({ timeout: 25_000 })
			for (const p of [page, pageB]) {
				await p.getByRole('button', { name: 'Explore Layers' }).click()
				await expect(p.getByText(/[\d,]+ matched layers/)).toBeVisible({ timeout: 25_000 })
			}
		} finally {
			await pageB.close()
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
				await expect(Dash.queueLabel(p, 'Queue (3)')).toBeVisible({ timeout: 25_000 })
			}

			const panelA = Dash.queueSection(page)
			const panelB = Dash.queueSection(pageB)

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

// a page on the app, once the login has landed
async function openPath(p: Page, path: string) {
	await p.goto(new URL(path, p.url()).href)
}

test.describe('collaborative rotation editing', () => {
	test("one editor sees the other's rotation edits live, and the save writes them", async ({ page, browser }) => {
		const second = await browser.newContext()
		const pageB = await second.newPage()
		try {
			await page.goto(app.loginUrl())
			await pageB.goto(app.loginUrl(SECOND_USER))
			for (const p of [page, pageB]) {
				await expect(p.getByRole('link', { name: 'Rotations' })).toBeVisible({ timeout: 25_000 })
				await openPath(p, '/rotations/weekend')
				await expect(p.getByRole('heading', { name: 'Layers (2)' })).toBeVisible({ timeout: 15_000 })
			}

			await page.getByRole('button', { name: 'Start Editing' }).click()
			await expect(pageB.getByRole('status')).not.toContainText('Nobody is editing')

			// B reads the draft as text, which follows edits made in A's builder
			await pageB.getByRole('button', { name: 'Text', exact: true }).click()
			const textB = pageB.getByRole('textbox', { name: 'Layers as Plain text' })
			await expect(textB).toContainText('Narva_RAAS_v1')

			// A deletes an item from the draft; B is watching the same draft, so B sees it go
			const listA = page.getByRole('region', { name: /Layers/ })
			await listA
				.getByRole('listitem')
				.filter({ hasText: layerText('Narva_RAAS_v1') })
				.getByRole('button', { name: 'Delete' })
				.click()
			await expect(pageB.getByRole('heading', { name: 'Layers (1)' })).toBeVisible({ timeout: 15_000 })
			await expect(textB).not.toContainText('Narva_RAAS_v1')
			await expect(textB).toContainText('Gorodok_RAAS_v1')
			// nothing is written until the draft is saved
			expect(savedRotation(app, 'weekend')?.items).toHaveLength(2)
			await pageB.getByRole('button', { name: 'Builder', exact: true }).click()

			// A is the only editor, so the button saves
			await page.getByRole('button', { name: 'Save', exact: true }).click()
			await app.waitFor(() => savedRotation(app, 'weekend')?.items.length === 1 || null, { label: 'the rotation lost its second item' })
			expect(savedRotation(app, 'weekend')!.items[0].layerId).toBe(LAYERS.gorodokRaas)
			await expect(pageB.getByRole('status')).toContainText('Nobody is editing')
		} finally {
			await second.close()
		}
	})

	test('finding, cloning, archiving and deleting a rotation from the rotations page', async ({ page }) => {
		await page.goto(app.loginUrl())
		await expect(page.getByRole('link', { name: 'Rotations' })).toBeVisible({ timeout: 25_000 })
		await openPath(page, '/rotations')
		await expect(page.getByRole('link', { name: 'Weekend Competitive' })).toBeVisible({ timeout: 15_000 })

		// a search lists matches as rows, says what matched, and is kept in the url
		await page.getByRole('textbox', { name: 'Search rotations' }).fill('gorodok')
		await expect(page).toHaveURL(/[?&]q=gorodok/)
		await expect(page.getByText('Match')).toBeVisible()
		await page.getByRole('textbox', { name: 'Search rotations' }).fill('')
		await expect(page).not.toHaveURL(/[?&]q=/)

		// clone opens the copy, under the default id
		await page
			.getByRole('listitem')
			.filter({ has: page.getByRole('link', { name: 'Weekend Competitive' }) })
			.getByRole('button', { name: 'Clone' })
			.click()
		const cloneDialog = page.getByRole('dialog', { name: 'Clone Rotation' })
		await expect(cloneDialog.getByLabel('ID')).toHaveValue('weekend-copy')
		await cloneDialog.getByRole('button', { name: 'Clone and Open' }).click()
		await expect(page).toHaveURL(/\/rotations\/weekend-copy/)
		await app.waitFor(() => savedRotation(app, 'weekend-copy') ?? null, { label: 'the copy was written' })
		expect(savedRotation(app, 'weekend-copy')!.items).toHaveLength(1)

		await openPath(page, '/rotations')
		const copyCard = page.getByRole('listitem').filter({ has: page.getByRole('link', { name: 'Weekend Competitive (copy)' }) })

		// a rotation is tagged from its menus, with a new tag or an existing one
		await copyCard.click({ button: 'right', position: { x: 300, y: 40 } })
		await page.getByRole('menuitem', { name: 'Tags' }).hover()
		await page.getByRole('menuitem', { name: 'New tag...' }).click()
		const tagDialog = page.getByRole('dialog', { name: 'New tag' })
		await tagDialog.getByLabel('Label').fill('Night Set')
		await tagDialog.getByRole('button', { name: 'Create' }).click()
		await expect(copyCard).toContainText('Night Set')
		await app.waitFor(() => savedRotation(app, 'weekend-copy')?.tags.length === 1 || null, { label: 'the copy was tagged' })
		await copyCard.getByRole('button', { name: 'More actions' }).click()
		await page.getByRole('menuitem', { name: 'Tags' }).hover()
		await page.getByRole('menuitem', { name: 'Night Set' }).click()
		await expect(copyCard).not.toContainText('Night Set')
		await app.waitFor(() => savedRotation(app, 'weekend-copy')?.tags.length === 0 || null, { label: 'the tag was taken off' })

		// an archived rotation is listed only when asked for
		await copyCard.getByRole('button', { name: 'More actions' }).click()
		await page.getByRole('menuitem', { name: 'Archive' }).click()
		await expect(copyCard).toBeHidden()
		await page.getByRole('checkbox', { name: /Show archived/ }).click()
		await expect(copyCard).toBeVisible()
		await expect(page).toHaveURL(/[?&]archived=true/)

		// deleting asks first
		await copyCard.getByRole('button', { name: 'More actions' }).click()
		await page.getByRole('menuitem', { name: 'Delete' }).click()
		await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click()
		await expect(copyCard).toBeHidden()
		await app.waitFor(() => savedRotation(app, 'weekend-copy') === undefined || null, { label: 'the copy was deleted' })
	})

	// replaces the queue, so it runs last
	test('adding a saved rotation to the queue in place of what was there', async ({ page }) => {
		await page.goto(app.loginUrl())
		await expect(Dash.queueSection(page)).toBeVisible({ timeout: 25_000 })
		await page.getByRole('button', { name: 'Start Editing' }).click()
		await page.getByRole('button', { name: 'Add Rotation' }).click()
		const dialog = page.getByRole('dialog', { name: 'Add Rotation' })
		await dialog.getByRole('button', { name: 'Saved Rotation' }).click()
		await dialog.getByRole('searchbox').fill('weekend')
		await dialog.getByRole('button', { name: /Weekend Competitive/ }).click()
		// the earlier journey saved the rotation down to its first layer
		await expect(dialog.getByRole('list', { name: 'Weekend Competitive' }).getByRole('listitem')).toHaveCount(1)
		await dialog.getByRole('button', { name: 'Replace', exact: true }).click()
		await dialog.getByRole('button', { name: 'Add 1 Item' }).click()
		await expect(dialog).toHaveCount(0)

		await expect(Dash.queueLabel(page, 'Queue (1)')).toBeVisible()
		const item = Dash.queueSection(page).getByRole('listitem').first()
		await expect(item).toContainText(layerText('Gorodok_RAAS_v1'))
		// every added item carries the rotation's tag, which renders as the rotation's name
		await expect(item).toContainText('Weekend Competitive')

		// after the earlier journeys, Gorodok's RGF breaks the faction repeat rule, so the save asks to be confirmed
		await page.getByRole('button', { name: 'Save', exact: true }).click()
		await expect(page.getByText('Repeats Detected')).toBeVisible()
		await page.getByRole('button', { name: 'Save Anyway' }).click()
		await app.waitFor(
			() => {
				const list = savedQueue(app)
				return (list.length === 1 && list[0].layerId === LAYERS.gorodokRaas) || null
			},
			{ label: 'the queue was replaced by the rotation' },
		)
		expect(savedQueue(app)[0].tags).toEqual([LTag.fromRotationTagId('weekend')])
	})

	test("downloading a rotation's layers, and editing them as YAML", async ({ page }) => {
		await page.goto(app.loginUrl())
		await expect(page.getByRole('link', { name: 'Rotations' })).toBeVisible({ timeout: 25_000 })
		await openPath(page, '/rotations/weekend')
		await expect(page.getByRole('heading', { name: 'Layers (1)' })).toBeVisible({ timeout: 15_000 })

		// the builder asks which format to download
		const downloading = page.waitForEvent('download')
		await page.getByRole('button', { name: 'Download', exact: true }).click()
		await page.getByRole('menuitem', { name: /Download \.yaml/ }).click()
		const download = await downloading
		expect(download.suggestedFilename()).toBe('weekend.yaml')
		expect(await fsp.readFile(await download.path(), 'utf8')).toBe('- Gorodok_RAAS_v1 USA+CombinedArms RGF+CombinedArms\n')

		await page.getByRole('button', { name: 'YAML', exact: true }).click()
		const editor = page.getByRole('textbox', { name: 'Layers as YAML' })
		await expect(editor).toContainText('- Gorodok_RAAS_v1 USA+CombinedArms RGF+CombinedArms')
		await page.getByRole('button', { name: 'Start Editing' }).click()
		await editor.click()
		await page.keyboard.press('ControlOrMeta+a')
		await page.keyboard.insertText(
			[
				'# opener',
				'- layer: Narva_RAAS_v1 USA+CombinedArms RGF+CombinedArms',
				'  tags: [meta, Rush Hour]',
				'- vote:',
				'    - Gorodok_RAAS_v1 USA+CombinedArms RGF+CombinedArms',
				'    - Skorpo_RAAS_v1 USA+CombinedArms RGF+CombinedArms',
			].join('\n'),
		)
		const region = page.getByRole('region', { name: /Layers/ })
		await expect(region.getByRole('status')).toHaveText('YAML: 2 items, 1 note')
		// an unknown tag holds the text back, and keeps the view from being switched
		await expect(region.getByRole('button', { name: 'Builder', exact: true })).toHaveAttribute('data-softdisabled', 'true')
		await expect(page.getByRole('heading', { name: 'Layers (1)' })).toBeVisible()
		await page.getByRole('combobox', { name: 'What to do with Rush Hour' }).click()
		await page.getByRole('option', { name: 'Drop it' }).click()
		await expect(page.getByRole('heading', { name: 'Layers (2)' })).toBeVisible()

		await page.getByRole('button', { name: 'Save', exact: true }).click()
		await app.waitFor(() => savedRotation(app, 'weekend')?.items.length === 2 || null, { label: 'the edit was saved' })
		const [narva, vote] = savedRotation(app, 'weekend')!.items
		expect(narva.layerId).toBe(LAYERS.narvaRaas)
		expect(narva.tags).toEqual([META.id])
		expect(narva.notes?.map((note) => [note.text, note.author])).toEqual([['opener', undefined]])
		expect(vote.choices?.map((choice) => choice.layerId)).toEqual([LAYERS.gorodokRaas, LAYERS.skorpoRaas])
	})

	test('the layer pickers keep the collection and the applied filters from Explore Layers and across rotations', async ({ page }) => {
		await page.goto(app.loginUrl())
		await expect(page.getByRole('link', { name: 'Rotations' })).toBeVisible({ timeout: 25_000 })

		await page.getByRole('button', { name: 'Explore Layers' }).click()
		const explore = page.getByRole('dialog', { name: 'Layers' })
		await explore.getByRole('combobox', { name: 'Collection' }).click()
		await page.getByRole('option', { name: 'GC', exact: true }).click()
		await explore.getByRole('button', { name: 'Edit extra filters' }).click()
		await page.getByRole('listbox').getByRole('option', { name: 'Narva Only' }).click()
		await page.keyboard.press('Escape')
		await explore.getByRole('checkbox', { name: 'Narva Only' }).click()
		await expect(explore.getByRole('checkbox', { name: 'Narva Only' })).toHaveAttribute('aria-checked', 'true')
		await page.keyboard.press('Escape')
		await expect(explore).toHaveCount(0)

		// in-app navigation throughout: the applied filters are shared in memory, so a page load would start them over
		await page.getByRole('link', { name: 'Rotations', exact: true }).click()
		await page.getByRole('link', { name: 'Weekend Competitive' }).click()
		await page.getByRole('button', { name: 'Add Layers' }).click()
		const weekendPicker = page.getByRole('dialog', { name: 'Add Layers' })
		await expect(weekendPicker.getByRole('combobox', { name: 'Collection' })).toHaveText('GC')
		const weekendExtra = weekendPicker.getByRole('checkbox', { name: 'Narva Only' })
		await expect(weekendExtra).toHaveAttribute('aria-checked', 'true')
		await weekendExtra.click()
		await expect(weekendExtra).toHaveAttribute('aria-checked', 'false')
		await page.keyboard.press('Escape')
		await expect(weekendPicker).toHaveCount(0)

		await page.getByRole('link', { name: 'Rotations', exact: true }).click()
		await page.getByRole('link', { name: 'Midweek Casual' }).click()
		await page.getByRole('button', { name: 'Add Layers' }).click()
		const midweekPicker = page.getByRole('dialog', { name: 'Add Layers' })
		await expect(midweekPicker.getByRole('combobox', { name: 'Collection' })).toHaveText('GC')
		await expect(midweekPicker.getByRole('checkbox', { name: 'Narva Only' })).toHaveAttribute('aria-checked', 'false')
		await page.keyboard.press('Escape')
		await expect(midweekPicker).toHaveCount(0)

		// Explore Layers stays set up while closed, and follows the change made in the rotation's picker
		await page.getByRole('button', { name: 'Explore Layers' }).click()
		await expect(explore.getByRole('checkbox', { name: 'Narva Only' })).toHaveAttribute('aria-checked', 'false')
	})

	test('a rotation tag can be made from the rotation editor and lands on the rotation', async ({ page }) => {
		await page.goto(app.loginUrl())
		await expect(page.getByRole('link', { name: 'Rotations', exact: true })).toBeVisible({ timeout: 25_000 })
		await openPath(page, '/rotations/midweek')
		await expect(page.getByRole('heading', { name: 'Layers (1)' })).toBeVisible({ timeout: 15_000 })

		// the tag made on the rotations page is offered beside a new one
		await page.getByRole('button', { name: 'Add tag' }).first().click()
		await expect(page.getByRole('menuitem', { name: 'Night Set' })).toBeVisible()
		await page.getByRole('menuitem', { name: 'New tag...' }).click()
		const dialog = page.getByRole('dialog', { name: 'New tag' })
		await expect(dialog).toContainText('group rotations on the Rotations page')
		await dialog.getByLabel('Label').fill('Casual Nights')
		await dialog.getByRole('button', { name: 'Create' }).click()
		await expect(dialog).toHaveCount(0)

		await expect(page.getByText('Casual Nights', { exact: true })).toBeVisible()
		await app.waitFor(() => savedRotation(app, 'midweek')?.tags.length === 1 || null, { label: 'the tag was put on the rotation' })
		expect(savedRotation(app, 'midweek')!.tags[0]).toMatch(/^Casual Nights:/)
	})

	test("a queue item's menu switches its tags and manages its notes", async ({ page }) => {
		await page.goto(app.loginUrl())
		await expect(page.getByRole('link', { name: 'Rotations', exact: true })).toBeVisible({ timeout: 25_000 })
		await openPath(page, '/rotations/weekend')
		await expect(page.getByRole('heading', { name: 'Layers (2)' })).toBeVisible({ timeout: 15_000 })
		await page.getByRole('button', { name: 'Start Editing' }).click()

		const list = page.getByRole('region', { name: /Layers/ })
		const narva = list
			.getByRole('listitem')
			.filter({ hasText: layerText('Narva_RAAS_v1') })
			.first()
		const openMenu = async () => {
			await narva.getByText(layerText('Narva_RAAS_v1')).first().click({ button: 'right' })
			await expect(page.getByRole('menuitem', { name: 'Clone' })).toBeVisible()
		}

		// the import gave Narva the meta tag, so the menu switches it off and back on
		await openMenu()
		await page.getByRole('menuitem', { name: 'Tags' }).hover()
		await page.getByRole('menuitem', { name: 'meta' }).click()
		await expect(narva.getByText('meta', { exact: true })).toHaveCount(0)
		await openMenu()
		await page.getByRole('menuitem', { name: 'Tags' }).hover()
		await page.getByRole('menuitem', { name: 'meta' }).click()
		await expect(narva.getByText('meta', { exact: true })).toBeVisible()

		await openMenu()
		await page.getByRole('menuitem', { name: 'Notes' }).hover()
		await page.getByRole('menuitem', { name: 'Add note...' }).click()
		const dialog = page.getByRole('dialog')
		await dialog.getByRole('textbox').fill('from the menu')
		await dialog.getByRole('button', { name: 'Add' }).click()
		await expect(narva).toContainText('from the menu')

		await openMenu()
		await page.getByRole('menuitem', { name: 'Notes' }).hover()
		await page.getByRole('menuitem', { name: 'from the menu' }).hover()
		// the note's own submenu, the last one open: the item menu has a Delete of its own
		await page.getByRole('menu').last().getByRole('menuitem', { name: 'Delete' }).click()
		await expect(narva).not.toContainText('from the menu')
	})
})
