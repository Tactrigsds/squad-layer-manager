import * as SLL from '@/models/shared-layer-list'
import type { OrpcAppRouter } from '@/server/orpc-app-router'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/websocket'
import type { RouterClient } from '@orpc/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { type AppFixture, createAppFixture } from '../harness/app-fixture'
import { LAYERS, queueItem } from '../harness/arrange'

// A queue save sets the next layer over RCON, which the game server reports back as a MAP_SET log line. That
// server event has to carry a `source` pointing at the QUEUE_UPDATED app event the save emitted, so the feed can
// fold it into that entry (see chat.models.ts handleEvent) instead of trailing it with a redundant "Next layer
// set to X" line.
//
// This drives the save over a real oRPC call rather than calling the handler directly, so it covers the whole
// path the UI takes: dispatch the ops, set the layer over RCON, ingest the log line the emulator writes back, and
// project the attribution onto the serverEvents row. The per-layer attribution matching this depends on is covered
// directly (and far more cheaply) by the MAP_SET attribution unit tests in pending-events.models.test.ts.
//
// `repeats` because attribution state is carried between saves: an attribution the previous save left behind is
// exactly what used to break the next one, and a single-save test can't see that.

let app: AppFixture
let client: RouterClient<OrpcAppRouter>
let socket: WebSocket

const HEAD_ITEM_ID = 'head-item'

// each repeat has to land on a layer that isn't already the server's next one, or syncNextLayerToServer
// short-circuits and no MAP_SET is ever produced. Distinct maps also keep the queue's repeat rules quiet.
const LAYER_CYCLE = [LAYERS.narvaRaas, LAYERS.skorpoRaas, LAYERS.sumariRaas, LAYERS.harjuRaas, LAYERS.gorodokAas]
let run = 0

beforeAll(async () => {
	app = await createAppFixture({
		layerQueue: [queueItem(LAYERS.gorodokRaas, { itemId: HEAD_ITEM_ID }), queueItem(LAYERS.sumariSeed)],
	})

	// the query-param bypass logs the seeded admin in and hands back the session cookie the /orpc upgrade authenticates
	const loginRes = await fetch(app.loginUrl(app.adminUser), { redirect: 'manual' })
	const cookie = loginRes.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
	expect(cookie, 'login did not set a session cookie').toContain('session-id=')

	socket = new WebSocket(`${app.appUrl.replace(/^http/, 'ws')}/orpc`, { headers: { cookie } })
	await new Promise<void>((resolve, reject) => {
		socket.once('open', resolve)
		socket.once('error', reject)
	})
	client = createORPCClient(new RPCLink({ websocket: socket as unknown as globalThis.WebSocket }))
}, 120_000)

afterAll(async () => {
	socket?.close()
	await app?.dispose()
})

function dispatch(op: SLL.Operation) {
	return client.layerQueue.dispatchOp({ serverId: app.serverId, op })
}

// the app event a MAP_SET server event for `layerId` is attributed to, or null if it landed unattributed.
// undefined while the event hasn't been written yet (events flush to the db on an interval).
function mapSetAttribution(layerId: string): { appEventId: string | null; appType: string | null } | undefined {
	const db = app.readDb()
	try {
		return db
			.prepare(
				`SELECT se.appEventId as appEventId, ae.type as appType
				 FROM serverEvents se LEFT JOIN appEvents ae ON ae.id = se.appEventId
				 WHERE se.type = 'MAP_SET' AND json_extract(se.data, '$.json.layerId') = ?
				 ORDER BY se.id DESC LIMIT 1`,
			)
			.get(layerId) as { appEventId: string | null; appType: string | null } | undefined
	} finally {
		db.close()
	}
}

describe('queue save attribution', () => {
	it("attributes the resulting MAP_SET to the save's QUEUE_UPDATED", { repeats: 4, timeout: 60_000 }, async () => {
		const layerId = LAYER_CYCLE[run++ % LAYER_CYCLE.length]

		// editWindowSeqId 0 is the fresh session's window: SLL.applyOperation only enforces a match for a non-zero id
		const editWindowSeqId = 0
		const userId = app.adminUser.discordId
		await dispatch({ op: 'edit-layer', itemId: HEAD_ITEM_ID, newLayerId: layerId, opId: SLL.createOpId(), userId, editWindowSeqId })
		await dispatch({ op: 'save', opId: SLL.createOpId(), userId, editWindowSeqId })

		const attribution = await app.waitFor(() => mapSetAttribution(layerId), {
			timeoutMs: 30_000,
			label: `MAP_SET server event for ${layerId}`,
		})

		// null here is the regression: an unattributed MAP_SET renders as its own redundant feed entry
		expect(attribution.appEventId, `MAP_SET for ${layerId} landed unattributed`).not.toBeNull()
		expect(attribution.appType).toBe('QUEUE_UPDATED')
	})
})
