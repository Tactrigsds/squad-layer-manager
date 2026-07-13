export namespace User {
	export const EMAIL = 'user.email'
	export const FULL_NAME = 'user.full_name'
	export const HASH = 'user.hash'
	export const ID = 'user.id'
	export const NAME = 'user.name'
	export const ROLES = 'user.roles'
}

export namespace SquadServer {
	export const ID = 'slm.squad_server.id'
	export const COUNT = 'slm.squad_server.count'
}

// Every spanOp records one of these, so the whole app gets rate/error/duration for free. `name` is the
// op's `module:name` (bounded by the number of spanOp call sites) and `outcome` is a fixed four-value
// enum, deliberately not the error code, which would be unbounded.
export namespace Op {
	export const DURATION = 'slm.op.duration'
	export const NAME = 'slm.op.name'
	export const OUTCOME = 'slm.op.outcome'
	export type Outcome = 'ok' | 'value-error' | 'error' | 'aborted'
}

export namespace Module {
	export const NAME = 'slm.module.name'
}

export namespace WebSocket {
	export const CLIENT_ID = 'slm.websocket.client_id'
	export const CONNECTED_CLIENTS = 'slm.websocket.connected_clients'
	export const CONNECTIONS = 'slm.websocket.connections'
	export const MESSAGES = 'slm.websocket.messages'
	export const IO = 'slm.websocket.io'
}

export namespace Span {
	export const ROOT_NAME = 'slm.span.root_name'
}

// Stable HTTP semconv. The old http.method/http.path/http.status_code names are deprecated, and the
// auto-instrumentations already emit these, so using anything else here means our hand-rolled client
// spans can't be queried alongside the instrumented ones.
export namespace Http {
	export const METHOD = 'http.request.method'
	export const PATH = 'url.path'
	export const STATUS_CODE = 'http.response.status_code'
}

export namespace Orpc {
	export const PATH = 'slm.orpc.path'
}

// Shared by every byte/message counter, so throughput can be summed or split by direction uniformly.
export namespace IO {
	export const DIRECTION = 'slm.io.direction'
	export type Direction = 'sent' | 'received'
}

export namespace Rcon {
	// The command verb only (`ListPlayers`, `AdminKick`, ...). Bounded, so it is safe as a metric
	// dimension and useful to group by in TraceQL. The full command text goes on BODY instead: it
	// carries player names and kick reasons, which would be unbounded as a metric label.
	export const COMMAND = 'slm.rcon.command'
	export const BODY = 'slm.rcon.body'
	export const CONNECTED = 'slm.rcon.connected'
	export const REQUESTS = 'slm.rcon.requests'
	export const IO = 'slm.rcon.io'
}

export namespace SquadLogs {
	export const SOURCE = 'slm.squad_logs.source'
	export type Source = 'sftp' | 'log-receiver' | 'local-file'
	export const LINES = 'slm.squad_logs.lines'
	export const IO = 'slm.squad_logs.io'
	export const EVENTS = 'slm.squad_logs.events'
}

// Server events are the app's own domain events, downstream of both log parsing and rcon polling, so
// this is deliberately not the same number as SquadLogs.EVENTS: one parsed log event can fan out into
// several server events, and some server events have no log line behind them at all.
export namespace ServerEvent {
	export const EMITTED = 'slm.server_events'
	export const TYPE = 'slm.server_event.type'
}

export namespace LayerQueue {
	export const OP = 'slm.layer_queue.op'
	export const OP_ID = 'slm.layer_queue.op_id'
	export const SIDE_EFFECT = 'slm.layer_queue.side_effect'
	export const LENGTH = 'slm.layer_queue.length'
	export const UNSAVED = 'slm.layer_queue.unsaved'
}

export namespace Teamswap {
	export const OP_CODES = 'slm.teamswap.op_codes'
	export const OP_CODE = 'slm.teamswap.op.code'
	export const OP_ID = 'slm.teamswap.op.id'
	export const OP_SUCCESS = 'slm.teamswap.op.success'
	export const SIDE_EFFECT = 'slm.teamswap.side_effect'
	export const SWAP_COUNT = 'slm.teamswap.swap_count'
	export const PLAYER_COUNT = 'slm.teamswap.player_count'
	export const PENDING_SWAPS = 'slm.teamswap.pending_swaps'
	export const SWAPPING = 'slm.teamswap.swapping'
	export const FAILURE_REASON = 'slm.teamswap.failure_reason'
}

export namespace UserPresence {
	export const OP_CODE = 'slm.user_presence.op.code'
	export const OP_ID = 'slm.user_presence.op.id'
	export const OP_SUCCESS = 'slm.user_presence.op.success'
}

export namespace Filter {
	export const ID = 'slm.filter.id'
	export const OUTCOME = 'slm.filter.outcome'
}

export namespace MatchHistory {
	export const CURRENT_LAYER_ID = 'slm.match_history.current_layer_id'
}

export namespace Session {
	export const LOCK = 'slm.session.lock'
}

export namespace Player {
	export const EOS_ID = 'slm.player.eos_id'
	export const STEAM_ID = 'slm.player.steam_id'
}

export namespace Vote {
	export const IN_PROGRESS = 'slm.vote.in_progress'
	export const INITIATOR = 'slm.vote.initiator'
	export const ABORTER = 'slm.vote.aborter'
	export const CANCELLED_BY = 'slm.vote.cancelled_by'
	export const END_REASON = 'slm.vote.end_reason'
	export const ENDED_BY = 'slm.vote.ended_by'
	export const ITEM_ID = 'slm.vote.item_id'
	export const VOTER_TYPE = 'slm.vote.voter_type'
}

// Attribute values must be primitives, so the id union has to be collapsed to a string by hand.
// Passing the object straight through gets it silently dropped by the SDK, and a raw bigint is not a
// valid attribute value either.
export function formatUserId(id: { discordId?: bigint; steamId?: string } | 'autostart' | undefined): string | undefined {
	if (id === undefined) return undefined
	if (id === 'autostart') return 'autostart'
	if (id.discordId !== undefined) return `discord:${id.discordId}`
	if (id.steamId !== undefined) return `steam:${id.steamId}`
	return undefined
}

// These are the BattleMetrics metrics, not a "rate limit" subsystem: the request counts happen to be
// the thing the rate limiter shapes, but they are the useful numbers regardless of whether we are
// anywhere near a limit. Also the only metrics we had that were not under the slm.* prefix.
export namespace Battlemetrics {
	export const REQUESTS_PER_SECOND = 'slm.battlemetrics.requests_per_second'
	export const REQUESTS_PER_MINUTE = 'slm.battlemetrics.requests_per_minute'
	export const QUEUE_SIZE = 'slm.battlemetrics.queue_size'
}

export namespace SpanLink {
	export const SOURCE = 'slm.link-source'
	export const SOURCE_TYPES = [
		// the span which invoked the event(or rx emission) that we're currently handling
		'event.emitter',
		'event.setup',
	] as const
	export type SourceType = (typeof SOURCE_TYPES)[number]
}
