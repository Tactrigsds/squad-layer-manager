import * as Rx from '@/lib/rxjs'
import { z } from '@/lib/zod'
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

// A channel outlives the managed server it describes, and is dropped only when the server itself is deleted.
//
// It has to. The console is opened to find out why a server is down, so the moments worth reading -- a refused
// connection, a rejected password, the teardown itself -- are all moments when there is no managed server. Ending
// the channel with the managed server would close every open console's stream at exactly that point, and an rpc
// stream that ends is not retried (see RPC.observe: it resubscribes on error, not on completion), so the window
// would sit there frozen and never recover when the server came back.
//
// The buffer survives the restart for the same reason. What separates the old connection's traffic from the new
// one's is the slm channel saying so, which is more use than an empty console.
export function disposeFor(serverId: string): void {
	const channel = channels.get(serverId)
	if (!channel) return
	channels.delete(serverId)
	channel.event$.complete()
}

// SLM's own view of this server: connection attempts, refusals, retries and teardowns. The one channel that has
// anything to say while the server is unreachable.
export function recordSlm(serverId: string, level: SC.SlmLevel, message: string, detail?: unknown): void {
	record(serverId, { type: 'slm', level, message, time: Date.now(), ...(detail === undefined ? {} : { detail: describe(detail) }) })
}

// Errors reach here from sockets, sftp and zod alike, and an admin needs the reason rather than the class name.
function describe(detail: unknown): string {
	if (typeof detail === 'string') return detail
	if (detail instanceof Error) {
		// node attaches the part an admin can act on (ECONNREFUSED, ENOTFOUND) to the error rather than the message
		const code = (detail as NodeJS.ErrnoException).code
		return code && !detail.message.includes(code) ? `${code}: ${detail.message}` : detail.message
	}
	try {
		return JSON.stringify(detail) ?? String(detail)
	} catch {
		return String(detail)
	}
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
				Rx.Ext.withAbortSignal(signal!),
			)
			yield* Rx.Ext.toAsyncGenerator(obs)
		}),
}
