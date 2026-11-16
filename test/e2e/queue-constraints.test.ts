import type { Page } from '@playwright/test'

import * as FB from '@/models/filter-builders.models'
import * as RRS from '@/models/repeat-rulesets.models'
import * as SLL from '@/models/shared-layer-list.models'

import { type AppFixture, createAppFixture, type TestUser } from '../harness/app-fixture'
import { filter, LAYERS, layerTag, layerText, queue, queueItem, role, selectableFilter } from '../harness/arrange'
import { pickOption } from '../harness/combo-box'
import * as Dash from '../harness/dashboard'
import { appEventData, savedPool, savedQueue, savedServerRepeatRuleset } from '../harness/inspect'
import { createOrpcClient, firstYield } from '../harness/orpc-client'
import { gotoReady } from '../harness/ready'
import { rearrange, type RearrangeOptions } from '../harness/rearrange'
import { expect, test } from './fixtures'
import { settledText } from './settle'

// What a queued layer violates has to be visible on the item itself: the indicators are the only thing
// standing between an admin and saving a queue that repeats a map or leaves the pool. They come from two
// independent sources -- the pool's repeat rules and its filters -- so both are exercised here, on a queue
// arranged so that each item carries a different combination of them.

// rules carry no id, so the seeded ruleset's one Map rule is found by its field
function mapRuleSaved(app: Parameters<typeof savedServerRepeatRuleset>[0]) {
	return savedServerRepeatRuleset(app)!.rules.find((rule) => rule.field === 'Map')!
}

async function saveSettings(page: Page) {
	const save = page.getByRole('button', { name: 'Save Changes' })
	await expect(save).toBeEnabled()
	await save.press('Enter')
}

// One app for the file. Each test re-arranges it into the queue, rules and pool it is about. What only some tests
// need and the rest ignore is seeded once: the filters, the tag and the second ruleset.
const planned = layerTag('planned', 'aaaaaa')
const MAP_RULE: RRS.RepeatRuleConfig = { label: 'Map', field: 'Map', within: 4, warn: true, indicate: true }
// a map the layer data does not have, so the filter cannot be applied
const BROKEN_POOL = 'broken-pool'
// may edit the queue but not queue a layer from outside the pool
const WRITER: TestUser = { discordId: 900000000000000031n, username: 'test-writer' }

let app: AppFixture

test.beforeAll(async () => {
	app = await createAppFixture({
		filters: [
			// exempts seeding and training layers from its miss indicator, as every filter does by default
			filter('raas-only', 'RAAS Only', FB.and([FB.eq('Gamemode', 'RAAS')]), {
				alertMessage: 'RAAS layers are in the pool',
				invertedEmoji: '⛔',
				invertedAlertMessage: 'Not a RAAS layer',
			}),
			filter('seed-layers', 'Seed Layers', FB.and([FB.eq('Gamemode', 'Seed')]), { emoji: '🌱', alertMessage: 'A seeding layer' }),
			filter(BROKEN_POOL, 'Broken Pool', FB.and([FB.eq('Gamemode', 'RAAS'), FB.eq('Map', 'NoSuchMap')])),
		],
		users: [WRITER],
		globalSettings: (settings) => {
			settings.layerTags = [planned]
			settings.rbac.roles['queue-writer'] = role(['site:authorized', 'queue:write'], { users: [WRITER] })
			settings.repeatRulesets.push({
				id: 'strict',
				name: 'Strict',
				rules: [{ field: 'Gamemode', within: 2, warn: true, indicate: true }],
			})
		},
	})
})

test.afterAll(async () => {
	await app?.dispose()
})

// every test names its rules and gets a pool rebuilt from defaults, so nothing carries over from the test before
function arrange(opts: Pick<RearrangeOptions, 'layerQueue' | 'pool'> & { repeatRules: RRS.RepeatRuleConfig[] }) {
	return rearrange(app, { ...opts, pool: opts.pool ?? (() => {}) })
}

test.describe('queue item constraints', () => {
	test('indicates repeat-rule violations, filter matches and unexempt misses on the items that carry them', async ({ page }) => {
		await arrange({
			// Gorodok twice, back to back: within the Map repeat rule's window of 4. A seeding layer between them would
			// end the rule's lookback, so Sumari's seeding layer comes last.
			layerQueue: queue(LAYERS.gorodokRaas, LAYERS.gorodokAas, LAYERS.sumariSeed),
			// just the one rule, so an item's indicators are attributable to it and nothing else
			repeatRules: [{ ...MAP_RULE, autogen: true }],
			pool: (pool) => {
				selectableFilter(pool, 'raas-only', { indicate: 'both' })
				pool.indicateMatches.push('seed-layers')
			},
		})
		await gotoReady(page, app.loginUrl())
		await expect(Dash.queueLabel(page, 'Queue (3)')).toBeVisible()

		const items = Dash.queueSection(page).getByRole('listitem')
		const indicators = (layerName: string) => items.filter({ hasText: layerName }).getByRole('button', { name: 'Layer indicators' })

		// the second Gorodok repeats the first, one match later
		await indicators('Gorodok_AAS_v1').hover()
		const repeatTooltip = page.getByRole('tooltip')
		await expect(repeatTooltip).toContainText('Map Gorodok repeats')
		await expect(repeatTooltip).toContainText('1 ago')
		// AAS is not RAAS, and nothing exempts it, so it carries the filter's miss indicator
		await expect(repeatTooltip).toContainText('Not in RAAS Only')
		await expect(repeatTooltip).toContainText('Not a RAAS layer')
		await expect(repeatTooltip).not.toContainText('Exempt')

		// dismiss the open tooltip before opening the next, so the assertions below can't read this one
		await page.keyboard.press('Escape')
		await expect(page.getByRole('tooltip')).toHaveCount(0)

		// the first Gorodok is RAAS, so it matches the pool filter -- and nothing precedes it to repeat
		await indicators('Gorodok_RAAS_v1').hover()
		const filterTooltip = page.getByRole('tooltip')
		await expect(filterTooltip).toContainText('In RAAS Only')
		await expect(filterTooltip).toContainText('RAAS layers are in the pool')
		await expect(filterTooltip).not.toContainText('repeats')

		await page.keyboard.press('Escape')
		await expect(page.getByRole('tooltip')).toHaveCount(0)

		// Sumari misses RAAS Only too, but as a seeding layer it is exempt: the miss is listed without its alert
		await indicators('Sumari_Seed_v1').hover()
		const exemptTooltip = page.getByRole('tooltip')
		await expect(exemptTooltip).toContainText('In Seed Layers')
		await expect(exemptTooltip).toContainText('Not in RAAS Only')
		await expect(exemptTooltip).toContainText('Exempt')
		await expect(exemptTooltip).not.toContainText('Not a RAAS layer')
	})

	// Indication is per rule, not per violation: two rules can find the same repeat and only the one that indicates
	// may say so.
	test('leaves a violation of a rule that does not indicate off the item', async ({ page }) => {
		await arrange({
			layerQueue: queue(LAYERS.gorodokRaas, LAYERS.harjuRaas, LAYERS.gorodokAas),
			// both rules are broken by the second Gorodok, so what the tooltip omits is down to `indicate` alone
			repeatRules: [MAP_RULE, { label: 'Recent map', field: 'Map', within: 4, warn: true, indicate: false }],
		})
		await gotoReady(page, app.loginUrl())
		await expect(Dash.queueLabel(page, 'Queue (3)')).toBeVisible()

		const items = Dash.queueSection(page).getByRole('listitem')
		await items
			.filter({ hasText: layerText('Gorodok_AAS_v1') })
			.getByRole('button', { name: 'Layer indicators' })
			.hover()
		const tooltip = page.getByRole('tooltip')
		await expect(tooltip).toContainText('Map Gorodok repeats')
		await expect(tooltip).not.toContainText('Recent map')
	})

	test('warns before saving a queue that violates a repeat rule the pool warns on', async ({ page }) => {
		await arrange({
			layerQueue: queue(LAYERS.gorodokRaas, LAYERS.sumariSeed),
			repeatRules: [MAP_RULE],
		})
		await gotoReady(page, app.loginUrl())
		await expect(Dash.queueLabel(page, 'Queue (2)')).toBeVisible()

		await page.getByRole('button', { name: 'Start Editing' }).click()
		await page.getByRole('button', { name: 'Add Layers' }).click()
		const dialog = page.getByRole('dialog', { name: 'Add Layers' })

		// add a second Gorodok layer, which repeats the head
		await dialog.getByRole('combobox', { name: 'Layer', exact: true }).click()
		await pickOption(page, 'Gorodok_AAS_v1')
		await dialog
			.getByRole('row')
			.filter({ hasText: layerText('Gorodok_AAS_v1') })
			.first()
			.click()
		await dialog.getByRole('button', { name: 'Submit' }).click()
		await expect(dialog).toBeHidden()

		// the warnings are only as fresh as the item statuses, which the server recomputes for the edited
		// queue; the repeat showing up on the item it applies to is what says they have landed
		const items = Dash.queueSection(page).getByRole('listitem')
		await expect(items.filter({ hasText: layerText('Gorodok_RAAS_v1') }).getByRole('button', { name: 'Layer indicators' })).toBeVisible()

		// the first save attempt surfaces the warning instead of committing, and the button changes to
		// say that saving now means saving anyway
		await page.getByRole('button', { name: /^(Save|Force Save)$/ }).click()
		await expect(page.getByText('Repeats Detected')).toBeVisible()
		const saveAnyway = page.getByRole('button', { name: 'Save Anyway' })
		await expect(saveAnyway).toBeVisible()

		await saveAnyway.click()
		await app.waitFor(
			() => {
				const db = app.readDb()
				try {
					const row = db.prepare(`SELECT layerQueue FROM servers WHERE id = ?`).get(app.serverId) as { layerQueue: string }
					const list = JSON.parse(row.layerQueue).json as { layerId: string }[]
					// the row clicked in the table is whichever Gorodok AAS layer sorts first, so match the layer
					// rather than a particular faction matchup of it
					return list.length === 3 && list[0].layerId.startsWith('Gorodok_AAS_v1:')
				} finally {
					db.close()
				}
			},
			{ label: 'queue saved over the repeat warning' },
		)
	})

	// Whoever saved a repeat into the queue owns it. An editor who adds an unrelated layer on top is told nothing, so
	// the warning that does fire keeps meaning "your edits did this".
	test('says nothing about a repeat that was in the saved queue already', async ({ page }) => {
		await arrange({
			// Gorodok twice, two apart: already repeating before anyone starts editing
			layerQueue: queue(LAYERS.gorodokRaas, LAYERS.harjuRaas, LAYERS.gorodokAas),
			repeatRules: [MAP_RULE],
		})
		await gotoReady(page, app.loginUrl())
		await expect(Dash.queueLabel(page, 'Queue (3)')).toBeVisible()

		const items = Dash.queueSection(page).getByRole('listitem')
		// the repeat is detected and indicated on the item; it is the save-time warning that is scoped to the session
		await expect(items.filter({ hasText: layerText('Gorodok_AAS_v1') }).getByRole('button', { name: 'Layer indicators' })).toBeVisible()

		await page.getByRole('button', { name: 'Start Editing' }).click()
		await page.getByRole('button', { name: 'Add Layers' }).click()
		const dialog = page.getByRole('dialog', { name: 'Add Layers' })
		await dialog.getByRole('combobox', { name: 'Layer', exact: true }).click()
		await pickOption(page, 'Narva_RAAS_v1')
		await dialog
			.getByRole('row')
			.filter({ hasText: layerText('Narva_RAAS_v1') })
			.first()
			.click()
		await dialog.getByRole('button', { name: 'Submit' }).click()
		await expect(dialog).toBeHidden()

		// Narva repeats nothing, and the Gorodok repeat is not this session's doing, so the save commits at once
		await page.getByRole('button', { name: /^(Save|Force Save)$/ }).click()
		await app.waitFor(
			() => {
				const db = app.readDb()
				try {
					const row = db.prepare(`SELECT layerQueue FROM servers WHERE id = ?`).get(app.serverId) as { layerQueue: string }
					const list = JSON.parse(row.layerQueue).json as { layerId: string }[]
					return list.length === 4 && list.some((item) => item.layerId.startsWith('Narva_RAAS_v1:'))
				} finally {
					db.close()
				}
			},
			{ label: 'queue saved without warning about the pre-existing repeat' },
		)
		await expect(page.getByText('Repeats Detected')).toHaveCount(0)
	})

	// The other half of the rule: a repeat can be this session's doing without either layer involved being touched,
	// because deleting what sat between them is what put them inside the rule's window.
	test('warns when a deletion pulls two untouched layers inside a repeat rule', async ({ page }) => {
		await arrange({
			// the two Gorodoks are three apart, one past the rule's window, so the saved queue repeats nothing
			layerQueue: queue(LAYERS.gorodokRaas, LAYERS.harjuRaas, LAYERS.narvaRaas, LAYERS.gorodokAas),
			repeatRules: [{ ...MAP_RULE, within: 2 }],
		})
		await gotoReady(page, app.loginUrl())
		await expect(Dash.queueLabel(page, 'Queue (4)')).toBeVisible()

		const items = Dash.queueSection(page).getByRole('listitem')
		await expect(items.filter({ hasText: layerText('Gorodok_AAS_v1') }).getByRole('button', { name: 'Layer indicators' })).toHaveCount(0)

		await page.getByRole('button', { name: 'Start Editing' }).click()
		await items
			.filter({ hasText: layerText('Harju_RAAS_v1') })
			.getByRole('button', { name: 'Delete' })
			.click()

		// two apart now, and the repeat lands on an item nobody edited: the deletion is the only thing that caused it
		await expect(items.filter({ hasText: layerText('Gorodok_AAS_v1') }).getByRole('button', { name: 'Layer indicators' })).toBeVisible()

		await page.getByRole('button', { name: /^(Save|Force Save)$/ }).click()
		await expect(page.getByText('Repeats Detected')).toBeVisible()
		await page.getByRole('button', { name: /^(Save Anyway|Force Save)$/ }).click()
		await app.waitFor(
			() => {
				const db = app.readDb()
				try {
					const row = db.prepare(`SELECT layerQueue FROM servers WHERE id = ?`).get(app.serverId) as { layerQueue: string }
					const list = JSON.parse(row.layerQueue).json as { layerId: string }[]
					return list.length === 3 && !list.some((item) => item.layerId.startsWith('Harju_RAAS_v1:'))
				} finally {
					db.close()
				}
			},
			{ label: 'queue saved over the deletion-induced repeat warning' },
		)
	})

	// The counterpart to the test above: the same violating queue saves without a word once the offending item carries
	// a tag the pool skips warnings for. The indicator is deliberately left alone -- the exemption silences the warning,
	// it doesn't hide what the layer does.
	test("skips warnings for an item tagged with one of the pool's skipWarningsForTags", async ({ page }) => {
		await arrange({
			layerQueue: [queueItem(LAYERS.gorodokRaas), queueItem(LAYERS.harjuRaas), queueItem(LAYERS.gorodokAas, { tags: [planned.id] })],
			repeatRules: [MAP_RULE],
			pool: (pool) => {
				pool.skipWarningsForTags = [planned.id]
			},
		})
		await gotoReady(page, app.loginUrl())
		await expect(Dash.queueLabel(page, 'Queue (3)')).toBeVisible()

		const items = Dash.queueSection(page).getByRole('listitem')
		// the repeat is still detected and still indicated on the item; only the warning is suppressed
		await expect(items.filter({ hasText: layerText('Gorodok_AAS_v1') }).getByRole('button', { name: 'Layer indicators' })).toBeVisible()

		// warnings only surface for a queue this user has edited, so make one that violates nothing itself: Narva
		// repeats neither the queue nor the match the emulated server is playing
		await page.getByRole('button', { name: 'Start Editing' }).click()
		await page.getByRole('button', { name: 'Add Layers' }).click()
		const dialog = page.getByRole('dialog', { name: 'Add Layers' })
		await dialog.getByRole('combobox', { name: 'Layer', exact: true }).click()
		await pickOption(page, 'Narva_RAAS_v1')
		await dialog
			.getByRole('row')
			.filter({ hasText: layerText('Narva_RAAS_v1') })
			.first()
			.click()
		await dialog.getByRole('button', { name: 'Submit' }).click()
		await expect(dialog).toBeHidden()
		// the added layer carries no indicator, so the only repeat in this queue is the tagged one
		const narva = items.filter({ hasText: layerText('Narva_RAAS_v1') })
		await expect(narva).toHaveCount(1)
		await expect(narva.getByRole('button', { name: 'Layer indicators' })).toHaveCount(0)

		// the save commits on the first attempt: had the tagged repeat still warned, this would have surfaced the
		// warning and waited for a second click instead
		await page.getByRole('button', { name: /^(Save|Force Save)$/ }).click()
		await app.waitFor(
			() => {
				const db = app.readDb()
				try {
					const row = db.prepare(`SELECT layerQueue FROM servers WHERE id = ?`).get(app.serverId) as { layerQueue: string }
					const list = JSON.parse(row.layerQueue).json as { layerId: string }[]
					return list.length === 4 && list.some((item) => item.layerId.startsWith('Narva_RAAS_v1:'))
				} finally {
					db.close()
				}
			},
			{ label: 'queue saved without a repeat warning' },
		)
		await expect(page.getByRole('button', { name: 'Save Anyway' })).toHaveCount(0)
		await expect(page.getByText('Repeats Detected')).toHaveCount(0)
	})

	// A stored filter stops applying when the layer data changes under it, while the pool configuration keeps naming it.
	// Every check that reads the configuration carries on without the filter, and the dashboard names it.
	test('names a pool filter that cannot be applied, and checks, saves and lists layers without it', async ({ page }) => {
		await arrange({
			layerQueue: queue(LAYERS.gorodokRaas),
			repeatRules: [],
			pool: (pool) => {
				pool.poolFilter = { filterId: BROKEN_POOL, mode: 'include' }
				selectableFilter(pool, 'raas-only', { indicate: 'both' })
			},
		})
		await gotoReady(page, app.loginUrl())
		await expect(Dash.queueLabel(page, 'Queue (1)')).toBeVisible()

		const banner = page.getByRole('alert').filter({ hasText: 'configuration cannot be applied' })
		await expect(banner).toContainText('1 filter in this server’s configuration cannot be applied')
		await expect(banner).toContainText('Pool filter')
		await expect(banner.getByRole('link', { name: 'Broken Pool' })).toHaveAttribute('href', `/filters/${BROKEN_POOL}`)
		await expect(banner.getByRole('link', { name: 'NoSuchMap is not a Map value in the layer data' })).toHaveAttribute(
			'href',
			`/filters/${BROKEN_POOL}?node=children.1`,
		)

		// the valid filter still marks the item, beside the mark for the filter it could not be checked against
		const items = Dash.queueSection(page).getByRole('listitem')
		const gorodok = items.filter({ hasText: layerText('Gorodok_RAAS_v1') })
		await expect(gorodok.getByRole('img', { name: 'Not checked' })).toBeVisible()
		await gorodok.getByRole('button', { name: 'Layer indicators' }).hover()
		await expect(page.getByRole('tooltip')).toContainText('In RAAS Only')
		await page.keyboard.press('Escape')
		await expect(page.getByRole('tooltip')).toHaveCount(0)

		await page.getByRole('button', { name: 'Start Editing' }).click()
		await page.getByRole('button', { name: 'Add Layers' }).click()
		const dialog = page.getByRole('dialog', { name: 'Add Layers' })
		await settledText(dialog)
		await expect(dialog.getByText('1 filter cannot be applied')).toBeVisible()
		await dialog.getByRole('combobox', { name: 'Layer', exact: true }).click()
		await pickOption(page, 'Narva_RAAS_v1')
		await dialog
			.getByRole('row')
			.filter({ hasText: layerText('Narva_RAAS_v1') })
			.first()
			.click()
		await dialog.getByRole('button', { name: 'Submit' }).click()
		await expect(dialog).toBeHidden()

		// an item's indicators show only once statuses computed for the edited queue land, and statuses that are
		// current let the save go ahead at once
		const narva = items.filter({ hasText: layerText('Narva_RAAS_v1') })
		await expect(narva.getByRole('button', { name: 'Layer indicators' })).toBeVisible()
		await expect(narva.getByRole('img', { name: 'Not checked' })).toBeVisible()

		await page.getByRole('button', { name: /^(Save|Force Save)$/ }).click()
		await app.waitFor(() => savedQueue(app).some((item) => item.layerId?.startsWith('Narva_RAAS_v1:')) || null, {
			label: 'the queue saved past the filter that cannot be applied',
		})
	})

	test('records the broken filter, and lets a writer without force-write add a layer past it', async () => {
		await app.waitFor(
			() => appEventData<{ filterId: string }>(app, 'FILTER_BROKEN').some((event) => event.filterId === BROKEN_POOL) || null,
			{ label: 'the FILTER_BROKEN event for the seeded filter' },
		)
		await arrange({
			layerQueue: queue(LAYERS.gorodokRaas),
			repeatRules: [],
			pool: (pool) => {
				pool.poolFilter = { filterId: BROKEN_POOL, mode: 'include' }
			},
		})

		const writer = await createOrpcClient(app, WRITER)
		const init = await firstYield((signal) => writer.layerQueue.watchOps({ serverId: app.serverId }, { signal }), {
			label: 'the queue session',
		})
		if (init.code !== 'init') throw new Error(`expected the queue session's init, got ${init.code}`)
		const editWindowSeqId = init.state.editWindowSeqId
		const userId = WRITER.discordId

		// a filter that could be applied would leave Harju out of the pool, and the writer could not add it
		const added = await writer.layerQueue.dispatchOp({
			serverId: app.serverId,
			op: {
				op: 'add',
				opId: SLL.createOpId(),
				userId,
				editWindowSeqId,
				items: [queueItem(LAYERS.harjuRaas)],
				index: { outerIndex: 0, innerIndex: null },
			},
		})
		expect(added.code).toBe('ok')
		const reset = await writer.layerQueue.dispatchOp({
			serverId: app.serverId,
			op: { op: 'reset-to-saved', opId: SLL.createOpId(), userId, editWindowSeqId },
		})
		expect(reset.code).toBe('ok')
	})

	// the pool filter gates rows for a user without force-write, so a broken one must not read as every layer missing it
	test('lets a writer without force-write pick and queue a layer in the Add Layers dialog past the broken pool filter', async ({
		page,
	}) => {
		await arrange({
			layerQueue: queue(LAYERS.gorodokRaas),
			repeatRules: [],
			pool: (pool) => {
				pool.poolFilter = { filterId: BROKEN_POOL, mode: 'include' }
			},
		})
		await gotoReady(page, app.loginUrl(WRITER), { signals: ['layer-engine'] })
		await expect(Dash.queueLabel(page, 'Queue (1)')).toBeVisible()

		await page.getByRole('button', { name: 'Start Editing' }).click()
		await page.getByRole('button', { name: 'Add Layers' }).click()
		const dialog = page.getByRole('dialog', { name: 'Add Layers' })
		await settledText(dialog)
		await expect(dialog.getByText('1 filter cannot be applied')).toBeVisible()
		await dialog.getByRole('combobox', { name: 'Layer', exact: true }).click()
		await pickOption(page, 'Narva_RAAS_v1')
		await dialog
			.getByRole('row')
			.filter({ hasText: layerText('Narva_RAAS_v1') })
			.first()
			.click()
		await expect(dialog.getByRole('button', { name: 'Submit' })).toBeEnabled()
		await dialog.getByRole('button', { name: 'Submit' }).click()
		await expect(dialog).toBeHidden()

		const items = Dash.queueSection(page).getByRole('listitem')
		await expect(items.filter({ hasText: layerText('Narva_RAAS_v1') })).toBeVisible()
		await page.getByRole('button', { name: 'Save', exact: true }).click()
		await app.waitFor(() => savedQueue(app).some((item) => item.layerId?.startsWith('Narva_RAAS_v1:')) || null, {
			label: 'the queue saved by the writer',
		})
	})

	// The exemption is only useful if an admin can set it up without editing settings by hand, so the pool
	// configuration window has to both render the control and persist what is picked in it. The repeat-rule leg
	// covers unsetting an optional field, which the window writes as a mutation with no value at all, and saving the
	// rules into the server's ruleset. The last leg points the server at another ruleset.
	test('persists pool configuration edits made in the window', async ({ page }) => {
		await arrange({ repeatRules: [...RRS.DEFAULT_RULES] })
		await gotoReady(page, app.loginUrl())
		await expect(page.getByRole('button', { name: 'Pool Configuration' })).toBeVisible()
		await page.getByRole('button', { name: 'Pool Configuration' }).click()

		const section = page.getByRole('region', { name: 'Skip warnings for' })
		await expect(section).toBeVisible()
		await section.getByRole('button', { name: /add tag/i }).click()
		await page.getByRole('menuitem', { name: 'planned' }).click()
		await expect(section.getByText('planned')).toBeVisible()

		await page.getByRole('button', { name: 'Save Changes' }).click()
		await app.waitFor(() => savedPool(app).skipWarningsForTags?.includes(planned.id) ?? false, {
			label: 'skipWarningsForTags persisted',
		})

		await page.getByRole('button', { name: 'Repeat Rules' }).click()
		// a rule has no identity of its own, so it is found by the field its unlabelled row is named after
		const mapRule = page
			.getByRole('listitem')
			.filter({ has: page.getByRole('combobox', { name: 'Rule' }).getByText('Map', { exact: true }) })
		// the row's third combobox, after the field picker and the target values
		const options = mapRule.getByRole('combobox').nth(2)
		await expect(options).toContainText('Autogen')
		await options.click()
		await page.getByRole('option', { name: 'Autogen', exact: true }).click()
		await page.keyboard.press('Escape')
		await expect(options).not.toContainText('Autogen')

		await page.getByRole('button', { name: 'Save Changes' }).click()
		await app.waitFor(() => mapRuleSaved(app).autogen === undefined, { label: 'the Map rule stopped constraining generation' })
		// the save round-trip must not put the option back
		await page.reload()
		await expect(page.getByRole('button', { name: 'Pool Configuration' })).toBeVisible({ timeout: 20_000 })
		await page.getByRole('button', { name: 'Pool Configuration' }).click()
		await page.getByRole('button', { name: 'Repeat Rules' }).click()
		await expect(mapRule.getByRole('combobox').nth(2)).not.toContainText('Autogen')

		// an unlabelled rule offers the box rather than showing it; emptying it again takes the label away.
		// Save is disabled until the debounced write lands, so clicking it waits for that on its own.
		await mapRule.getByRole('button', { name: 'Add label' }).click()
		await mapRule.getByRole('textbox', { name: 'Label' }).fill('Recent map')
		await saveSettings(page)
		await app.waitFor(() => mapRuleSaved(app).label === 'Recent map', { label: 'the Map rule took its label' })

		await mapRule.getByRole('textbox', { name: 'Label' }).fill('')
		await saveSettings(page)
		await app.waitFor(() => mapRuleSaved(app).label === undefined, { label: 'the Map rule gave its label back' })

		await page.getByRole('combobox', { name: 'Choose a repeat ruleset' }).click()
		await page.getByRole('option', { name: 'Strict', exact: true }).click()
		// the rules shown are the chosen ruleset's, before anything is saved
		await expect(page.getByRole('combobox', { name: 'Rule', exact: true })).toHaveText('Gamemode')
		await saveSettings(page)
		await app.waitFor(() => savedPool(app).repeatRulesetId === 'strict', { label: 'the server took the Strict ruleset' })
	})
})
