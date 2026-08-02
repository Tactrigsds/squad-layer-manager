import type { AppFixture, TestUser } from '../harness/app-fixture'
import { createOrpcClient, type TestOrpcClient } from '../harness/orpc-client'
import { type Recorder, type Rng, sleep } from './metrics'

// Dashboard viewers, minus the browser. Each one holds the same websocket and the same set of live
// subscriptions a real page does, so the server pays the same fan-out per connection: every roster poll, chat
// line, queue edit and settings change is serialised once per client here.
//
// This is the only way to reach realistic concurrency. A browser costs a few hundred megabytes; a hundred of
// these cost a socket each, and what they exercise -- the per-subscription work in the server -- is exactly
// what a hundred browsers would.

// Every stream a loaded dashboard holds open. Split by whether the procedure is scoped to a server, because
// that is the only thing that differs in how they are called.
const GLOBAL_STREAMS = [
	'config.watchConfig',
	'settings.public.watchPublicSettings',
	'settings.global.watchSettings',
	'filters.watchFilters',
	'filters.watchFilterReferences',
	'users.watchUserInvalidation',
	'userPresence.watchUpdates',
	'timeouts.watchActiveTimeouts',
	'battlemetrics.watchPlayerBmData',
	'squadServer.watchLoadedServers',
] as const

const SERVER_STREAMS = [
	'squadServer.watchLayersStatus',
	'squadServer.watchServerInfo',
	'squadServer.watchServerRolling',
	'squadServer.watchTickRate',
	'squadServer.watchChatEvents',
	'settings.server.watchSettings',
	'layerQueue.watchOps',
	'layerQueue.watchIngameVote',
	'layerQueue.watchUnexpectedNextLayer',
	'matchHistory.watchMatchHistoryState',
	'teamswaps.watchUpdates',
	'vote.watchUpdates',
] as const

function streamCalls(serverId: string): [string, unknown][] {
	return [
		...GLOBAL_STREAMS.map((path) => [path, undefined] as [string, unknown]),
		...SERVER_STREAMS.map((path) => [path, { serverId }] as [string, unknown]),
	]
}

export type SyntheticOptions = {
	app: AppFixture
	recorder: Recorder
	rng: Rng
	signal: AbortSignal
	users: TestUser[]
	// mean gap between one client's polls of the read-only procedures a dashboard refetches
	pollIntervalMs: number
}

export type SyntheticFleet = {
	connect: () => Promise<void>
	run: () => Promise<void>
	close: () => void
	// how many stream messages every client received between them, which is the fan-out the server paid for
	messagesReceived: () => number
}

export function createSyntheticFleet(opts: SyntheticOptions): SyntheticFleet {
	const clients: TestOrpcClient[] = []
	let messages = 0

	// Each subscription is consumed to exhaustion in its own task. Errors are recorded rather than thrown: a
	// stream that dies mid-run is a finding, and taking the whole fleet down with it would hide the rest.
	async function drain(label: string, stream: AsyncIterable<unknown>) {
		try {
			for await (const _ of stream) {
				messages++
				if (opts.signal.aborted) return
			}
		} catch (err) {
			if (!opts.signal.aborted) opts.recorder.fail(`synthetic:${label}`, err)
		}
	}

	// oRPC exposes each procedure as a nested callable; the stream names above are the paths to them. Resolved by
	// path rather than written out so the two lists stay readable as the list of what a dashboard holds open.
	//
	// The procedure is invoked directly. `.call(input, ...)` is the tanstack-query wrapper's api, which is what
	// the client code uses -- on a RouterClient it resolves to Function.prototype.call, which quietly passes the
	// options object as the input and gets a 404 back for every stream.
	function procedure(
		client: TestOrpcClient,
		path: string,
	): (input: unknown, opts: { signal: AbortSignal }) => Promise<AsyncIterable<unknown>> {
		return path.split('.').reduce<Record<string, unknown>>((node, key) => node[key] as Record<string, unknown>, client as never) as never
	}

	// Each subscription is opened on its own. One that a user is not permitted to hold, or that has been renamed
	// out from under the lists above, is recorded and skipped rather than taking the fleet down: a client short
	// one stream still generates the load the other twenty produce.
	async function subscribeAll(client: TestOrpcClient) {
		const started = performance.now()
		const tasks: Promise<void>[] = []
		for (const [path, input] of streamCalls(opts.app.serverId)) {
			try {
				tasks.push(drain(path, await procedure(client, path)(input, { signal: opts.signal })))
			} catch (err) {
				opts.recorder.fail(`synthetic:subscribe:${path}`, err)
			}
		}
		opts.recorder.record('synthetic:subscribe-all', performance.now() - started)
		void Promise.all(tasks)
	}

	// What a dashboard refetches while it is open, rather than receives. Kept to reads: writes are the browser
	// actors' job, and a hundred of these racing the same queue would measure contention nobody has.
	async function poll(client: TestOrpcClient) {
		const { recorder, rng, app, signal } = opts
		while (!signal.aborted) {
			await sleep(rng.jitter(opts.pollIntervalMs), signal)
			if (signal.aborted) return
			switch (rng.int(4)) {
				case 0:
					await recorder.time('synthetic:getUsers', () => client.users.getUsers(undefined, { signal }))
					break
				case 1:
					await recorder.time('synthetic:listAppEvents', () => client.appEvents.list({ limit: 50 }, { signal }))
					break
				case 2:
					await recorder.time('synthetic:getLoggedInUser', () => client.users.getLoggedInUser(undefined, { signal }))
					break
				default:
					await recorder.time('synthetic:getMatchEvents', async () => {
						const latest = app.readDb()
						try {
							// the match before the current one: the handler refuses the current one outright, since a match
							// still running is served by the live event stream instead
							const row = latest.prepare(`SELECT ordinal FROM matchHistory ORDER BY id DESC LIMIT 1 OFFSET 1`).get() as
								| { ordinal: number }
								| undefined
							if (!row) return
							await client.matchHistory.getMatchEvents({ serverId: app.serverId, ordinal: row.ordinal }, { signal })
						} finally {
							latest.close()
						}
					})
			}
		}
	}

	return {
		messagesReceived: () => messages,
		connect: async () => {
			for (const user of opts.users) {
				const client = await createOrpcClient(opts.app, user)
				clients.push(client)
				await subscribeAll(client)
			}
		},
		run: async () => {
			await Promise.all(clients.map((client) => poll(client)))
		},
		// Only after the app is down. Closing a live client rejects whatever subscription its socket was
		// carrying, and nothing is awaiting those by then (see the note in test/harness/orpc-client.ts).
		close: () => {
			for (const client of clients) client.close()
		},
	}
}
