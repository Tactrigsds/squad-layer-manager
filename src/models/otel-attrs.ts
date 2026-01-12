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
}

export namespace Module {
	export const NAME = 'slm.module.name'
}

export namespace WebSocket {
	export const CLIENT_ID = 'slm.websocket.client_id'
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
