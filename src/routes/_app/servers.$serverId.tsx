import LayerQueueDashboard from '@/components/layer-queue-dashboard'
import { withAbortSignal } from '@/lib/async'
import * as Browser from '@/lib/browser'
import * as PresenceActions from '@/models/shared-layer-list/presence-actions'
import * as Cookies from '@/systems.client/app-routes.client'
import * as SLLClient from '@/systems.client/shared-layer-list.client'
import * as SquadServerClient from '@/systems.client/squad-server.client'
import { createFileRoute } from '@tanstack/react-router'
import * as Rx from 'rxjs'

export const Route = createFileRoute('/_app/servers/$serverId')({
	component: RouteComponent,

	onEnter({ abortController, params }) {
		// -------- schedule presence updates, keep default server id up-to-date --------
		Cookies.setCookie('default-server-id', params.serverId)
		SquadServerClient.SelectedServerStore.getState().setSelectedServer(params.serverId)

		const timeout$ = Rx.of(false).pipe(Rx.delay(PresenceActions.INTERACT_TIMEOUT))
		const interaction$ = Browser.interaction$.pipe(
			Rx.scan((acc) => acc + 1, 0),
			Rx.audit(t => t === 1 ? Rx.of(true) : Rx.of(true).pipe(Rx.delay(2000))),
			Rx.switchMap(() => Rx.concat(Rx.of(true), timeout$)),
			withAbortSignal(abortController.signal),
		)

		interaction$.subscribe((active) => {
			try {
				const storeState = SLLClient.Store.getState()
				if (active) {
					// if the user comes back to this page we want to set this as the default server again
					SquadServerClient.SelectedServerStore.getState().setSelectedServer(params.serverId)
					storeState.pushPresenceAction(PresenceActions.pageInteraction)
				} else {
					storeState.pushPresenceAction(PresenceActions.interactionTimeout)
				}
			} catch (error) {
				console.error('Error in pushing pageInteraction$', error)
			}
		})
	},

	onLeave() {
		const storeState = SLLClient.Store.getState()
		storeState.pushPresenceAction(PresenceActions.navigatedAway)
	},
})

function RouteComponent() {
	return <LayerQueueDashboard />
}
