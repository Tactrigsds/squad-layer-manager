import { createId } from '@/lib/id'
import * as Rx from '@/lib/rxjs'
import * as ANN_Msgs from '@/messages/announcements.messages'
import * as AppEvents from '@/models/app-events.models'
import type * as CS from '@/models/context-shared'
import type * as C from '@/server/context'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as AppEventsSys from '@/systems/app-events.server'
import * as SquadRcon from '@/systems/squad-rcon.server'
import * as SquadServer from '@/systems/squad-server.server'

/**
 * A notice to everyone operating SLM: a banner for every web user, and a warn to every in-game admin on every
 * running server. Sent over the control socket, typically by a deployment about to restart the app.
 *
 * Held in memory only, so a restart clears it. A new announcement replaces the current one.
 */

const module = initModule('announcements')
const orpcBase = getOrpcBase(module)

export type Announcement = { id: string; message: string; sentAt: number; expiresAt: number }

const announcement$ = new Rx.BehaviorSubject<Announcement | null>(null)
let expiryTimer: ReturnType<typeof setTimeout> | undefined

function setCurrent(announcement: Announcement | null) {
	clearTimeout(expiryTimer)
	expiryTimer = undefined
	if (announcement) expiryTimer = setTimeout(() => announcement$.next(null), announcement.expiresAt - Date.now()).unref()
	announcement$.next(announcement)
}

export async function announce(ctx: C.Db & CS.Log & CS.AbortSignal, message: string, durationMs: number) {
	const sentAt = Date.now()
	const announcement: Announcement = { id: createId(8), message, sentAt, expiresAt: sentAt + durationMs }
	setCurrent(announcement)

	await AppEventsSys.persistAppEvent(
		ctx,
		AppEvents.create<AppEvents.AnnouncementSent>({
			type: 'ANNOUNCEMENT_SENT',
			actor: { type: 'system' },
			serverId: null,
			matchId: null,
			causeId: null,
			message,
			expiresAt: announcement.expiresAt,
		}),
	)

	// one unreachable server must not keep the others' admins from hearing about it
	const warned: string[] = []
	const failed: string[] = []
	await Promise.all(
		[...SquadServer.globalState.managedServers].map(async ([serverId, managedServer]) => {
			try {
				await SquadRcon.warnAllAdmins({ ...ctx, ...managedServer }, ANN_Msgs.ingameWarn(message))
				warned.push(serverId)
			} catch (err) {
				ctx.log.warn(err, 'failed to warn admins on %s of an announcement', serverId)
				failed.push(serverId)
			}
		}),
	)
	return { announcement, warned, failed }
}

export function clear() {
	const had = announcement$.value !== null
	setCurrent(null)
	return had
}

export const router = {
	watch: orpcBase.meta({ logLevel: 'trace' }).handler(async function* ({ signal }) {
		yield* Rx.Ext.toAsyncGenerator(announcement$.pipe(Rx.Ext.withAbortSignal(signal!)))
	}),
}
