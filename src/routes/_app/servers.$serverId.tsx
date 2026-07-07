import ServerDashboard from '@/components/server-dashboard'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { frameManager } from '@/frames/frame-manager'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import * as Browser from '@/lib/browser'
import * as FRM from '@/lib/frame'
import * as ZusUtils from '@/lib/zustand'
import * as UP from '@/models/user-presence'
import * as RootRouter from '@/root-router'
import * as ClientOnlySettings from '@/systems/client-only-settings.client'
import * as SettingsClient from '@/systems/settings.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as UPClient from '@/systems/user-presence.client'
import { createFileRoute, Link } from '@tanstack/react-router'
import { AlertCircle, Home } from 'lucide-react'
import React from 'react'
import * as Rx from 'rxjs'

export const Route = createFileRoute('/_app/servers/$serverId')({
	component: RouteComponent,

	loader: async ({ params }) => {
		const settings = await SettingsClient.fetchSettings()
		const serverConfig = settings.servers.find(s => s.id === params.serverId)
		// only spin up a frame for a server that actually has a live backend slice; disabled/broken/missing servers
		// render the "unavailable" view instead (see RouteComponent, which recomputes this reactively)
		return {
			displayName: serverConfig?.displayName ?? params.serverId,
			squadServerFrameKey: SettingsClient.isServerUsable(serverConfig)
				? frameManager.ensureSetup(SquadServerFrame.frame, SquadServerFrame.createInput(params.serverId))
				: undefined,
		}
	},

	head: ({ loaderData }) => ({
		meta: [
			{ title: loaderData?.displayName ? `${loaderData?.displayName} - SLM` : undefined },
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

function RouteComponent() {
	const serverId = Route.useParams().serverId
	const { squadServerFrameKey } = Route.useLoaderData()
	const settings = ZusUtils.useStore(SettingsClient.PublicSettingsStore)
	const serverConfig = settings?.servers.find(s => s.id === serverId)
	// derived from the live settings store so disabling the server mid-session flips this to the unavailable view. we also
	// need the frame the loader created; if the server was re-enabled after nav there's no frame yet, so fall back to the card.
	const canRenderDashboard = SettingsClient.isServerUsable(serverConfig) && squadServerFrameKey !== undefined
	React.useEffect(() => {
		if (!canRenderDashboard) {
			return
		}
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
	}, [canRenderDashboard, serverId])

	if (!canRenderDashboard) {
		return (
			<div className="flex items-center justify-center min-h-screen p-4 w-full">
				<Card className="w-full max-w-lg">
					<CardHeader className="text-center pb-4">
						<CardTitle className="text-2xl">
							{serverConfig
								? <>Server "{serverConfig.displayName}" Unavailable</>
								: <>Server "{serverId}" Not Found</>}
						</CardTitle>
					</CardHeader>
					<CardContent className="space-y-4">
						<Alert variant="destructive">
							<AlertCircle className="h-4 w-4" />
							<AlertTitle>What happened?</AlertTitle>
							<AlertDescription>
								{serverConfig
									? "This server is currently disabled and can't be loaded right now. If you have access, first please enable it in the settings page."
									: 'This server may have been removed from the configuration or the server ID is incorrect.'}
							</AlertDescription>
						</Alert>
						{settings && settings.servers.some(s => SettingsClient.isServerUsable(s))
							? (
								<div className="space-y-3">
									<div className="text-sm font-medium text-muted-foreground">Available servers:</div>
									<div className="space-y-2">
										{settings.servers.filter(s => SettingsClient.isServerUsable(s)).map((server) => (
											<Link key={server.id} to="/servers/$serverId" params={{ serverId: server.id }}>
												<Button variant="outline" className="w-full justify-start" size="lg">
													<Home className="mr-2 h-4 w-4" />
													{server.displayName}
												</Button>
											</Link>
										))}
									</div>
								</div>
							)
							: (
								<div className="pt-2">
									<Link to="/" className="block">
										<Button className="w-full" size="lg">
											<Home className="mr-2 h-4 w-4" />
											Go Back to Servers List
										</Button>
									</Link>
								</div>
							)}
					</CardContent>
				</Card>
			</div>
		)
	}

	return <ServerDashboard stores={FRM.toProp(squadServerFrameKey!)} />
}
