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

export namespace Rcon {
	export const COMMAND = 'slm.rcon.command'
	export const CONNECTED = 'slm.rcon.connected'
}

export namespace LayerQueue {
	export const OP = 'slm.layer_queue.op'
	export const OP_ID = 'slm.layer_queue.op_id'
	export const SIDE_EFFECT = 'slm.layer_queue.side_effect'
	export const LENGTH = 'slm.layer_queue.length'
	export const UNSAVED = 'slm.layer_queue.unsaved'
}

export namespace Teamswitch {
	export const OP_CODES = 'slm.teamswitch.op_codes'
	export const OP_CODE = 'slm.teamswitch.op.code'
	export const OP_ID = 'slm.teamswitch.op.id'
	export const OP_SUCCESS = 'slm.teamswitch.op.success'
	export const SIDE_EFFECT = 'slm.teamswitch.side_effect'
	export const SWITCH_COUNT = 'slm.teamswitch.switch_count'
	export const PLAYER_COUNT = 'slm.teamswitch.player_count'
	export const PENDING_SWITCHES = 'slm.teamswitch.pending_switches'
	export const SWITCHING = 'slm.teamswitch.switching'
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

export namespace Battlemetrics {
	export namespace RateLimit {
		export const PER_SECOND = 'battlemetrics.rate_limit.per_second'
		export const PER_MINUTE = 'battlemetrics.rate_limit.per_minute'
		export const QUEUE_SIZE = 'battlemetrics.rate_limit.queue_size'
	}
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
