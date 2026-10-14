import superjson from 'superjson'

import type * as BB from '@/models/backburner.models'
import type * as LL from '@/models/layer-list.models'
import type * as RRS from '@/models/repeat-rulesets.models'
import * as SETTINGS from '@/models/settings.models'
import * as SLL from '@/models/shared-layer-list.models'

import { type AppFixture, TEST_REPEAT_RULESET_ID } from './app-fixture'
import { savedBackburner, savedGlobalSettings, savedQueue } from './inspect'
import { createOrpcClient, firstYield, type TestOrpcClient } from './orpc-client'

// Re-arranges a running app the way createAppFixture arranges one before boot, so tests whose only difference is
// their starting queue, rules or settings can share one boot. Every change goes through the procedures the
// settings page and the queue editor use, as the seeded admin, and each step returns only once the db holds it.
//
// Filters are not re-arrangeable here: seed every filter a file needs at boot, since one nothing references is
// inert.

export type RearrangeOptions = {
	layerQueue?: LL.List
	backburner?: BB.BackburnerItem[]
	// the rules of the test server's own ruleset, as createAppFixture's `repeatRules`
	repeatRules?: RRS.RepeatRuleConfig[]
	globalSettings?: (settings: SETTINGS.GlobalSettings) => void
	serverSettings?: (settings: SETTINGS.ServerSettings) => void
	// the server's pool, rebuilt from its defaults (keeping the ruleset it points at) before this runs, so a test
	// never inherits pool config an earlier one set. Runs after serverSettings.
	pool?: (pool: SETTINGS.PoolConfiguration) => void
}

// one admin client per app, left open: see the teardown note in orpc-client.ts
const adminClients = new WeakMap<AppFixture, Promise<TestOrpcClient>>()
function adminClient(app: AppFixture): Promise<TestOrpcClient> {
	let client = adminClients.get(app)
	if (!client) adminClients.set(app, (client = createOrpcClient(app)))
	return client
}

export async function rearrange(app: AppFixture, opts: RearrangeOptions): Promise<void> {
	const client = await adminClient(app)
	if (opts.globalSettings || opts.repeatRules) {
		await updateGlobalSettings(app, client, (settings) => {
			if (opts.repeatRules) {
				const ruleset = settings.repeatRulesets.find((r) => r.id === TEST_REPEAT_RULESET_ID)
				if (!ruleset) throw new Error(`no ruleset ${TEST_REPEAT_RULESET_ID} to set the rules of`)
				ruleset.rules = [...opts.repeatRules]
			}
			opts.globalSettings?.(settings)
		})
	}
	if (opts.serverSettings || opts.pool) {
		await updateServerSettings(app, client, (settings) => {
			opts.serverSettings?.(settings)
			if (opts.pool) {
				const repeatRulesetId = settings.queue.mainPool.repeatRulesetId
				settings.queue.mainPool = { ...SETTINGS.PoolConfigurationSchema.parse({}), repeatRulesetId }
				opts.pool(settings.queue.mainPool)
			}
		})
	}
	if (opts.layerQueue) await replaceQueue(app, client, opts.layerQueue)
	if (opts.backburner) await replaceBackburner(app, client, opts.backburner)
}

// the top-level keys whose encoded form the mutation changed, with their new encoded values
function changedKeys(before: Record<string, unknown>, after: Record<string, unknown>): [string, unknown][] {
	return Object.keys(after)
		.filter((key) => superjson.stringify(before[key]) !== superjson.stringify(after[key]))
		.map((key) => [key, after[key]])
}

async function updateGlobalSettings(app: AppFixture, client: TestOrpcClient, mutate: (settings: SETTINGS.GlobalSettings) => void) {
	const parsed = SETTINGS.parseGlobalSettings(savedGlobalSettings(app))
	if (!parsed.success) throw new Error(`saved global settings do not parse: ${parsed.error.message}`)
	const next = structuredClone(parsed.data)
	mutate(next)
	const changed = changedKeys(SETTINGS.GlobalSettingsSchema.encode(parsed.data), SETTINGS.GlobalSettingsSchema.encode(next))
	if (changed.length === 0) return
	const res = await client.settings.global.updateSettings(Object.fromEntries(changed))
	if (res.code !== 'ok') throw new Error(`global settings update refused: ${JSON.stringify(res)}`)
}

function savedServerSettings(app: AppFixture): unknown {
	const db = app.readDb()
	try {
		const row = db.prepare(`SELECT settings FROM servers WHERE id = ?`).get(app.serverId) as { settings: string }
		return superjson.parse(row.settings)
	} finally {
		db.close()
	}
}

async function updateServerSettings(app: AppFixture, client: TestOrpcClient, mutate: (settings: SETTINGS.ServerSettings) => void) {
	const parsed = SETTINGS.ServerSettingsSchema.safeParse(savedServerSettings(app))
	if (!parsed.success) throw new Error(`saved server settings do not parse: ${parsed.error.message}`)
	const next = structuredClone(parsed.data)
	mutate(next)
	const changed = changedKeys(SETTINGS.ServerSettingsSchema.encode(parsed.data), SETTINGS.ServerSettingsSchema.encode(next))
	if (changed.length === 0) return
	const res = await client.settings.server.updateSettings({
		serverId: app.serverId,
		ops: changed.map(([key, value]) => ({ path: [key], value })),
	})
	if (res.code !== 'ok') throw new Error(`server settings update refused: ${JSON.stringify(res)}`)
}

async function queueState(app: AppFixture, client: TestOrpcClient): Promise<SLL.State> {
	const first = await firstYield((signal) => client.layerQueue.watchOps({ serverId: app.serverId }, { signal }), {
		label: 'the queue session',
	})
	if (first.code !== 'init') throw new Error(`expected the queue session's init, got ${first.code}`)
	return first.state
}

async function dispatch(app: AppFixture, client: TestOrpcClient, op: SLL.Operation) {
	const res = await client.layerQueue.dispatchOp({ serverId: app.serverId, op })
	if (res.code !== 'ok') throw new Error(`${op.op} refused: ${JSON.stringify(res)}`)
}

// Swaps the whole draft, including anything a previous test left unsaved, for `list` in one op, then saves it.
async function replaceQueue(app: AppFixture, client: TestOrpcClient, list: LL.List) {
	const state = await queueState(app, client)
	const userId = app.adminUser.discordId
	const source: LL.Source = { type: 'manual', userId }
	const editWindowSeqId = state.editWindowSeqId
	await dispatch(app, client, {
		op: 'add',
		opId: SLL.createOpId(),
		userId,
		source,
		editWindowSeqId,
		items: list,
		index: { outerIndex: 0, innerIndex: null },
		clearItemIds: state.list.map((item) => item.itemId),
	})
	await dispatch(app, client, { op: 'save', opId: SLL.createOpId(), userId, source, editWindowSeqId })
	const want = list.map((item) => item.itemId).join()
	await app.waitFor(
		() =>
			savedQueue(app)
				.map((item) => item.itemId)
				.join() === want || null,
		{ label: 'the re-arranged queue saved' },
	)
}

async function replaceBackburner(app: AppFixture, client: TestOrpcClient, items: BB.BackburnerItem[]) {
	const state = await queueState(app, client)
	const userId = app.adminUser.discordId
	const source: LL.Source = { type: 'manual', userId }
	const editWindowSeqId = state.backburnerEditWindowSeqId
	const stale = state.backburner.map((item) => item.itemId)
	if (stale.length > 0) {
		await dispatch(app, client, { op: 'backburner-remove', opId: SLL.createOpId(), userId, source, editWindowSeqId, itemIds: stale })
	}
	for (const item of items) {
		await dispatch(app, client, { op: 'backburner-add', opId: SLL.createOpId(), userId, source, editWindowSeqId, item })
	}
	await dispatch(app, client, { op: 'backburner-save', opId: SLL.createOpId(), userId, source })
	const want = items.map((item) => item.itemId).join()
	await app.waitFor(
		() =>
			savedBackburner(app)
				.map((item) => item.itemId)
				.join() === want || null,
		{
			label: 'the re-arranged backburner saved',
		},
	)
}
