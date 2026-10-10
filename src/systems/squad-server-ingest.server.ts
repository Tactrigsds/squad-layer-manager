// The event ingest pipeline: log events and SLM attributions run through the pending-events state machine, and
// the server events it produces are persisted and published on event$.

import * as Otel from '@opentelemetry/api'
import * as Timers from 'node:timers/promises'

import * as Prom from '@/lib/promise-utils'
import type * as CS from '@/models/context-shared.models'
import type * as L from '@/models/layer.models'
import * as ATTRS from '@/models/otel-attrs.models'
import * as PendingEvents from '@/models/pending-events.models'
import type * as SE from '@/models/server-events.models'
import type * as SQS from '@/models/squad-server.models'
import type * as C from '@/server/context.ts'
import * as DB from '@/server/db'
import * as EventWrites from '@/systems/server-event-writes.server'
import * as SquadServer from '@/systems/squad-server.server'

const meter = Otel.metrics.getMeter('squad-server')

const serverEventCounter = meter.createCounter(ATTRS.ServerEvent.EMITTED, {
	description: 'Server events emitted on event$, by server and event type',
})

export async function pushAttribution(ctx: SQS.Ctx & C.Db & CS.AbortSignal, attribution: Omit<PendingEvents.Attribution, 'time'>) {
	await collectEvents(ctx, () => {
		PendingEvents.pushAttribution(ctx.server.eventState, attribution)
	})
}

export async function withdrawAttribution(ctx: SQS.Ctx & CS.AbortSignal, itemId: string, layerId: L.LayerId) {
	await collectEvents(ctx, () => {
		PendingEvents.withdrawAttribution(ctx.server.eventState, itemId, layerId)
	})
}

// Runs the steps, then one processing pass over the pending-events state, all under one hold of processEventsMtx.
// The events the pass produces are persisted as they are produced and published on event$ once their batch commits.
export async function collectEvents(ctx: SQS.Ctx & CS.AbortSignal, ...steps: (() => void)[]) {
	using _lock = await Prom.acquireInBlock(ctx.server.processEventsMtx, { signal: ctx.signal })
	const ingest = ingestByServer.get(ctx.server)!
	try {
		for (const step of steps) step()
		await PendingEvents.process(ctx.server.eventState, Date.now())
	} finally {
		publishIngested(ingest)
	}
}

// The events of one collectEvents call share a write batch, so a burst costs one COMMIT rather than one per event.
// An event reaches event$ only once its batch has committed, so no listener sees a write that could still be lost.
export type EventIngest = {
	serverId: string
	event$: SQS.Ctx.Payload['event$']
	db: C.Db & CS.Log
	writes: DB.WriteBatch | null
	unpublished: SE.Event[]
}

export const ingestByServer = new WeakMap<SQS.Ctx.Payload, EventIngest>()

// bounds how long a batch holds the process-wide transaction lock, and how long ingest runs without yielding
const MAX_UNPUBLISHED_EVENTS = 50

export const LOG_EVENTS_PER_SLICE = 50

export async function ingestEvent(ingest: EventIngest, newEvent: SE.NewEvent): Promise<SE.Event> {
	ingest.writes ??= await DB.openWriteBatch()
	const writes = ingest.writes
	const event = writes.write(() => EventWrites.insertEvent(ingest.db, ingest.serverId, newEvent))
	ingest.unpublished.push(event)
	if (ingest.unpublished.length >= MAX_UNPUBLISHED_EVENTS) {
		publishIngested(ingest)
		// one processing pass can release hundreds of held rcon events at once
		await Timers.setImmediate()
	}
	return event
}

function publishIngested(ingest: EventIngest) {
	const writes = ingest.writes
	const events = ingest.unpublished
	if (!writes) return
	ingest.writes = null
	ingest.unpublished = []
	try {
		writes.commit()
	} catch (err) {
		SquadServer.log.error(err, 'failed to commit %d server events, so they are not published', events.length)
		return
	}
	for (const event of events) {
		// the single funnel for every server event, whatever produced it
		serverEventCounter.add(1, {
			[ATTRS.SquadServer.ID]: ingest.serverId,
			[ATTRS.ServerEvent.TYPE]: event.type,
		})
		ingest.event$.emit(event)
	}
}

// a hook that reaches rcon or opens a transaction of its own cannot run while a batch holds the transaction lock
export function publishingFirst<Args extends unknown[], R>(ingest: EventIngest, hook: (...args: Args) => Promise<R>) {
	return (...args: Args) => {
		publishIngested(ingest)
		return hook(...args)
	}
}
