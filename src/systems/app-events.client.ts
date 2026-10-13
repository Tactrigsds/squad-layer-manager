// Naming who performed an app event, and telling a user when something they had open was deleted.
import { toast } from '@/lib/toast'
import { assertNever } from '@/lib/type-guards'
import * as AppEvents_Msgs from '@/messages/app-events.messages'
import type * as AppEvents from '@/models/app-events.models'
import { tr } from '@/systems/messages.client'
import * as PluginsClient from '@/systems/plugins.client'
import * as UsersClient from '@/systems/users.client'

export async function fetchActorName(actor: AppEvents.Actor): Promise<string> {
	switch (actor.type) {
		case 'slm-user':
			return await UsersClient.fetchDisplayName(actor.userId)
		case 'plugin':
			return PluginsClient.Store.getState().plugins.find((p) => p.id === actor.pluginId)?.name ?? actor.pluginId
		case 'system':
			return tr.text(AppEvents_Msgs.systemActor())
		case 'ingame-user':
			return tr.text(AppEvents_Msgs.unnamedActors['ingame-user'])
		default:
			assertNever(actor)
	}
}

export type DeletedItem =
	| { index: '/rotations'; to: '/rotations/$rotationId'; params: { rotationId: string } }
	| { index: '/filters'; to: '/filters/$filterId'; params: { filterId: string } }

// Tells a user on a deleted item's page, or on the index page that lists it, who deleted it. A user on the item's
// page is sent to the index first, past any unsaved-changes prompt, since nothing is left to save. The toast follows
// the navigation, so it shows on the index page.
export async function reportDeletion(opts: {
	item: DeletedItem
	actor: AppEvents.Actor
	describe: (actorName: string) => ReturnType<typeof tr.toast>
}) {
	// the router imports every route, and with them the systems that call this
	const { rootRouter } = await import('@/root-router')
	const { item } = opts
	const path = withoutTrailingSlash(rootRouter.state.location.pathname)
	let itemPath: string
	switch (item.index) {
		case '/rotations':
			itemPath = rootRouter.buildLocation({ to: item.to, params: item.params }).pathname
			break
		case '/filters':
			itemPath = rootRouter.buildLocation({ to: item.to, params: item.params }).pathname
			break
		default:
			assertNever(item)
	}
	const onItem = path === withoutTrailingSlash(itemPath)
	if (!onItem && path !== item.index) return
	const [actorName] = await Promise.all([
		fetchActorName(opts.actor),
		onItem ? rootRouter.navigate({ to: item.index, ignoreBlocker: true }) : undefined,
	])
	toast(...opts.describe(actorName))
}

function withoutTrailingSlash(path: string) {
	return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}
