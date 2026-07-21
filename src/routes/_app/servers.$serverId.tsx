import ServerDashboard from '@/components/server-dashboard'
import ServerUnavailable from '@/components/server-unavailable'
import { useFrameLifecycle, useFrameTeardownOnUnmount } from '@/frames/frame-manager'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import * as Browser from '@/lib/browser'
import * as FRM from '@/lib/frame'
import { toast } from '@/lib/toast'
import * as ZusUtils from '@/lib/zustand'
import * as UP from '@/models/user-presence'
import * as RootRouter from '@/root-router'
import * as ClientOnlySettings from '@/systems/client-only-settings.client'
import * as SettingsClient from '@/systems/settings.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as UPClient from '@/systems/user-presence.client'
import * as ReactRx from '@react-rxjs/core'
import { createFileRoute, useBlocker } from '@tanstack/react-router'
import React from 'react'
import * as Rx from 'rxjs'

export const Route = createFileRoute('/_app/servers/$serverId')({
	component: RouteComponent,

	loader: async ({ params }) => {
		const settings = await SettingsClient.fetchSettings()
		const serverConfig = settings.servers.find(s => s.id === params.serverId)
		return { displayName: serverConfig?.displayName ?? params.serverId }
	},

	head: ({ loaderData }) => ({
		meta: [
			{ title: loaderData?.displayName ? `SLM - ${loaderData?.displayName}` : undefined },
		],
	}),

	onEnter({ params }) {
		// capture how we got here so the component can decide whether to establish presence
		// immediately (navigated in) or wait for the user's first interaction (fresh load / refresh)
		enteredViaNavigation = RootRouter.arrivedViaNavigation()
		SquadServerClient.SelectedServerActions.setSelectedServer(params.serverId)
	},

	onLeave() {
		UPClient.Actions.dispatch({ code: 'navigated-away' })
	},
})

// set by onEnter, read once by the route effect on mount. module-level because onEnter can't hand
// state to the component directly, and it only ever runs immediately before the matching mount.
let enteredViaNavigation = false

// availability is read outside the squadServer frame (it's what decides whether the frame exists at all), so nothing else
// holds its stream open -- this boundary is the subscriber. Suspension while it waits for its first emit is handled by the
// route's pending component.
function RouteComponent() {
	const serverId = Route.useParams().serverId
	return (
		<ReactRx.Subscribe source$={SquadServerClient.serverAvailability$(serverId)}>
			<ServerRoute serverId={serverId} />
		</ReactRx.Subscribe>
	)
}

function ServerRoute({ serverId }: { serverId: string }) {
	// tracks both the registry (enabled/broken) and the backend's live slices, so enabling, disabling, or losing a server
	// mid-session swaps between the dashboard and the unavailable view without a reload
	const availability = SquadServerClient.useServerAvailability(serverId)

	if (availability !== 'ok') return <ServerUnavailable serverId={serverId} status={availability} />
	// keyed so that losing and regaining a server builds a fresh frame rather than reviving the stale one
	return <ServerDashboardHost key={serverId} serverId={serverId} />
}

// owns the frame for as long as the server is actually available: mounting sets it up, unmounting (i.e. the server
// becoming unavailable, or navigating away) tears it down along with all of its per-server subscriptions.
function ServerDashboardHost(props: { serverId: string }) {
	const frameKey = useFrameLifecycle(SquadServerFrame.frame, {
		input: SquadServerFrame.createInput(props.serverId),
	})
	useFrameTeardownOnUnmount(frameKey)

	const serverId = props.serverId
	useUnsavedEditsGuard(FRM.toProp(frameKey), serverId)
	React.useEffect(() => {
		const sub = new Rx.Subscription()

		// A user is "engaged" on this dashboard once they either navigated in or interacted. Until then
		// they stay absent from presence (null activity). Engaging publishes presence reflecting the
		// currently visible panel; staying engaged, the mirror below keeps it in sync with tab switches.
		let engaged = false
		const engage = () => {
			engaged = true
			UPClient.Actions.ensureViewingPanel(serverId, ClientOnlySettings.Store.getState().primaryPanelTab)
		}

		// arriving via in-app navigation is itself engagement -- establish immediately
		if (enteredViaNavigation) engage()

		// while engaged, mirror the visible panel into presence so VIEWING_QUEUE / VIEWING_TEAMS tracks
		// the tab the user is actually looking at
		sub.add(
			ZusUtils.toObservable(ClientOnlySettings.Store, true).pipe(
				Rx.map(([s]) => s.primaryPanelTab),
				Rx.distinctUntilChanged(),
			).subscribe((panel) => {
				if (engaged) UPClient.Actions.ensureViewingPanel(serverId, panel)
			}),
		)

		// An "active session" can only be opened by a deliberate interaction (userInteracted$) -- this is
		// what engages a fresh-loaded client and brings an away user back. Once open, ANY activity
		// including mouse movement (userIsActive$) keeps it alive; INTERACT_TIMEOUT of total silence ends
		// it (away). Mouse movement alone never opens a session, so it can extend but never initiate.
		const active$ = Browser.userInteracted$.pipe(
			// exhaustMap: a deliberate interaction opens a session and further ones are ignored until it
			// ends -- while open, the inner userIsActive$ (which includes those deliberate events) handles
			// keep-alive, so we only need the outer to catch the interaction that *starts* a session.
			Rx.exhaustMap(() =>
				Browser.userIsActive$.pipe(
					Rx.startWith(true as const),
					Rx.throttleTime(2000, undefined, { leading: true, trailing: true }),
					Rx.switchMap(() => Rx.concat(Rx.of(true), Rx.of(false).pipe(Rx.delay(UP.INTERACT_TIMEOUT)))),
					// the trailing `false` ends the session; stop there so movement can't silently revive it
					Rx.takeWhile((active) => active, true),
				)
			),
		)
		sub.add(active$.subscribe((active) => {
			try {
				if (active) {
					// if the user comes back to this page we want to set this as the default server again
					SquadServerClient.SelectedServerActions.setAsDefaultServer()
					// engage() re-establishes via the idempotent ensureViewingPanel, so interacting also
					// recovers presence after another of this user's clients remotely reset this one
					engage()
					UPClient.Actions.dispatch({ code: 'page-interaction' })
				} else {
					UPClient.Actions.dispatch({ code: 'interaction-timeout' })
				}
			} catch (error) {
				console.error('Error handling dashboard presence interaction', error)
			}
		}))

		return () => {
			sub.unsubscribe()
		}
	}, [serverId])

	return <ServerDashboard stores={FRM.toProp(frameKey)} />
}

// The queue and the layer-request drafts are shared, and the server drops one the moment its last editor
// goes away: leaving with edits nobody else is holding loses them. So warn on the way out, and once we are
// gone say what happened -- the dashboard is torn down by then, so the discard itself is never seen.
function useUnsavedEditsGuard(stores: SquadServerFrame.KeyProp, serverId: string) {
	const [queueModified, requestsModified] = ZusUtils.useStore(
		stores.squadServer!,
		ZusUtils.useShallow(s => [s.queue.isModified, s.queue.backburnerModified]),
	)
	const [editingQueue] = UPClient.useEditingQueueState(serverId)
	const [editingRequests] = UPClient.useEditingLayerRequestsState(serverId)
	const queueEditors = ZusUtils.useStore(UPClient.Store, UPClient.Sel.editingClientCount(serverId, 'queue'))
	const requestEditors = ZusUtils.useStore(UPClient.Store, UPClient.Sel.editingClientCount(serverId, 'layer-requests'))

	const wouldDiscard = (editingQueue && queueModified && queueEditors <= 1)
		|| (editingRequests && requestsModified && requestEditors <= 1)
	const wouldDiscardRef = React.useRef(wouldDiscard)
	wouldDiscardRef.current = wouldDiscard

	useBlocker({
		enableBeforeUnload: wouldDiscard,
		shouldBlockFn: () => {
			if (!wouldDiscardRef.current) return false
			return !confirm('Leaving discards your unsaved edits, since nobody else is editing. Are you sure you want to leave?')
		},
	})

	React.useEffect(() => () => {
		if (wouldDiscardRef.current) toast.info('Your unsaved edits have been discarded')
	}, [])
}
