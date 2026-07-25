import * as Rx from 'rxjs'
import { z } from 'zod'

import { toAsyncGenerator, withAbortSignal } from '@/lib/async'
import type * as CS from '@/models/context-shared'
import * as SC from '@/models/server-console.models'
import * as RBAC from '@/rbac.models'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as Rbac from '@/systems/rbac.server'

// What each squad server is saying and being told, kept per server as a short tail. Every connection type feeds
// this the same way, so the console reads identically whether the server is real, tunnelled through an agent, or
// emulated in-process.
//
// The buffer exists so a window opened mid-match has something in it. It is memory-only and deliberately small:
// this is a live view, and anything worth keeping is already an app event or a server event.

const module = initModule('server-console')
const orpcBase = getOrpcBase(module)
let log!: CS.Logger

type Channel = {
	buffer: SC.ConsoleEvent[]
	event$: Rx.Subject<SC.ConsoleEvent>
	nextSeq: number
	bytes: number
	// a log chunk is not line-aligned, so the tail of one is the head of the next
	partialLine: string
}

const channels = new Map<string, Channel>()

function channelFor(serverId: string): Channel {
	let channel = channels.get(serverId)
	if (!channel) {
		channel = { buffer: [], event$: new Rx.Subject<SC.ConsoleEvent>(), nextSeq: 1, bytes: 0, partialLine: '' }
		channels.set(serverId, channel)
	}
	return channel
}

export function setup() {
	log = module.getLogger()
}

// Called from the hot path of every rcon write and every log chunk, so it does no work beyond appending: no
// formatting, no serialization, and nothing that can throw into the caller.
export function record(serverId: string, event: SC.ConsoleEventInput): void {
	const channel = channelFor(serverId)
	const stamped = { ...event, seq: channel.nextSeq++ } as SC.ConsoleEvent
	channel.buffer.push(stamped)
	channel.bytes += SC.eventSize(stamped)
	let dropped = 0
	while (dropped < channel.buffer.length && (channel.buffer.length - dropped > SC.BUFFER_SIZE || channel.bytes > SC.BUFFER_BYTES)) {
		channel.bytes -= SC.eventSize(channel.buffer[dropped])
		dropped++
	}
	if (dropped > 0) channel.buffer.splice(0, dropped)
	channel.event$.next(stamped)
}

export function recordLogChunk(serverId: string, chunk: string, time: number): void {
	const channel = channelFor(serverId)
	const { lines, partial } = SC.splitChunk(channel.partialLine, chunk)
	channel.partialLine = partial
	for (const line of lines) record(serverId, { type: 'log', line, time })
}

// A slice teardown drops the tail with it: the events describe a connection that no longer exists, and keeping
// them would leave a restarted server showing the previous one's traffic.
export function disposeFor(serverId: string): void {
	const channel = channels.get(serverId)
	if (!channel) return
	channels.delete(serverId)
	channel.event$.complete()
}

export const orpcRouter = {
	// The tail, backlog first and then live. Batched rather than one message per line: a busy server produces log
	// lines faster than a websocket round trip, and the console renders them in batches anyway.
	watch: orpcBase
		.meta({ logLevel: 'trace' })
		.input(z.object({ serverId: z.string() }))
		.handler(async function* ({ context, input, signal }) {
			const denyRes = await Rbac.tryDenyPermissionsForUser(context, RBAC.perm('squad-server:view-console', { serverId: input.serverId }))
			if (denyRes) {
				yield { code: 'err:permission-denied' as const, events: [] as SC.ConsoleEvent[] }
				return
			}
			const channel = channelFor(input.serverId)
			log.info('Server %s: user %s opened the console', input.serverId, context.user.discordId)

			const backlog = Rx.of(channel.buffer.slice())
			const live = channel.event$.pipe(
				Rx.bufferTime(120),
				Rx.filter((batch) => batch.length > 0),
			)
			const obs = Rx.concat(backlog, live).pipe(
				Rx.filter((events) => events.length > 0),
				Rx.map((events) => ({ code: 'ok' as const, events })),
				withAbortSignal(signal!),
			)
			yield* toAsyncGenerator(obs)
		}),
}
