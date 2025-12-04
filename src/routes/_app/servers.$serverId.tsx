import LayerQueueDashboard from '@/components/layer-queue-dashboard'
import { globalToast$ } from '@/hooks/use-global-toast'
import * as Browser from '@/lib/browser'
import * as SS from '@/models/server-state.models'
import * as PresenceActions from '@/models/shared-layer-list/presence-actions'
import * as ConfigClient from '@/systems.client/config.client'
import * as ServerSettingsClient from '@/systems.client/server-settings.client'
import * as SLLClient from '@/systems.client/shared-layer-list.client'
import * as SquadServerClient from '@/systems.client/squad-server.client'
import { createFileRoute } from '@tanstack/react-router'
import React from 'react'
import * as Rx from 'rxjs'

export const Route = createFileRoute('/_app/servers/$serverId')({
	component: RouteComponent,

	loader: async ({ params }) => {
		const config = await ConfigClient.fetchConfig()
		const serverConfig = config.servers.find(s => s.id === params.serverId)
		return {
			displayName: serverConfig?.displayName ?? params.serverId,
		}
	},

	head: ({ loaderData }) => ({
		meta: [
			{ title: loaderData?.displayName ? `${loaderData?.displayName} - SLM` : undefined },
		],
	}),

	onEnter({ params }) {
		void SquadServerClient.SelectedServerStore.getState().setSelectedServer(params.serverId)
	},

	onLeave() {
		const storeState = SLLClient.Store.getState()
		storeState.pushPresenceAction(PresenceActions.navigatedAway)
	},
})

function RouteComponent() {
	const serverId = Route.useParams().serverId
	React.useEffect(() => {
		// -------- schedule presence updates, keep default server id up-to-date --------

		const timeout$ = Rx.of(false).pipe(Rx.delay(PresenceActions.INTERACT_TIMEOUT))
		const interaction$ = Browser.userIsActive$.pipe(
			Rx.scan((acc) => acc + 1, 0),
			Rx.audit(t => t === 1 ? Rx.of(true) : Rx.of(true).pipe(Rx.delay(2000))),
			Rx.switchMap(() => Rx.concat(Rx.of(true), timeout$)),
		)
		const sub = new Rx.Subscription()

		sub.add(interaction$.subscribe((active) => {
			try {
				const storeState = SLLClient.Store.getState()
				if (active) {
					// if the user comes back to this page we want to set this as the default server again
					void SquadServerClient.SelectedServerStore.getState().setSelectedServer(serverId)
					storeState.pushPresenceAction(PresenceActions.pageInteraction)
				} else {
					storeState.pushPresenceAction(PresenceActions.interactionTimeout)
				}
			} catch (error) {
				console.error('Error in pushing pageInteraction$', error)
			}
		}))

		sub.add(ServerSettingsClient.serverSettings$.subscribe(([settings, source]) => {
			if (!source) return
			globalToast$.next({
				title: SS.printSource(source),
			})
		}))

		return () => sub.unsubscribe()
	}, [serverId])

	return <LayerQueueDashboard />
}
