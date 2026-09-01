import React from 'react'

import * as Zus from '@/lib/zustand'
import * as AppEvents from '@/models/app-events.models'
import type * as CHAT from '@/models/chat.models'
import type * as USR from '@/models/users.models'
import * as PartsSys from '@/systems/parts.client'
import * as PluginsClient from '@/systems/plugins.client'
import * as UsersClient from '@/systems/users.client'

import type * as RC from './render-context'

/**
 * Display names for the actors the given events attribute work to, for a render ctx.
 *
 * The app-event rows are inert templates, so a row cannot fetch its own actor's name. The ids are collected
 * from the events up front and fetched in one batch instead, which is the same work the rows used to do
 * individually -- only hoisted to where the ctx is built, since the ctx's identity is what says a built row
 * is stale.
 */
export function useActorLabels(events: readonly CHAT.EventEnriched[] | null | undefined): Pick<RC.RenderCtx, 'userLabel' | 'pluginName'> {
	const userIds = React.useMemo(() => {
		const ids = new Set<USR.UserId>()
		for (const event of events ?? []) {
			if (event.type !== 'APP_EVENT') continue
			for (const id of AppEvents.iterAssocUserIds(event.appEvent)) ids.add(id)
		}
		return [...ids]
	}, [events])

	const loggedInUser = UsersClient.useLoggedInUser()
	const plugins = Zus.useStore(PluginsClient.Store, (s) => s.plugins)

	// users already carried by a response (or the viewer themselves) need no fetch; the rest go in one batch
	const unresolved = React.useMemo(
		() => userIds.filter((id) => !PartsSys.findUser(id) && id !== loggedInUser?.discordId),
		[userIds, loggedInUser],
	)
	const fetched = UsersClient.useUsers(unresolved, { enabled: unresolved.length > 0 })
	const fetchedUsers = fetched.data?.code === 'ok' ? fetched.data.users : undefined

	return React.useMemo(() => {
		const labels = new Map<USR.UserId, string>()
		for (const id of userIds) {
			const name =
				(id === loggedInUser?.discordId ? loggedInUser.displayName : undefined) ??
				PartsSys.findUser(id)?.displayName ??
				fetchedUsers?.find((u) => u.discordId === id)?.displayName
			if (name !== undefined) labels.set(id, name)
		}
		const pluginNames = new Map(plugins.map((p) => [p.id, p.name]))
		return {
			userLabel: (userId: USR.UserId) => labels.get(userId),
			pluginName: (pluginId: string) => pluginNames.get(pluginId),
		}
	}, [userIds, loggedInUser, fetchedUsers, plugins])
}
