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
import * as ClientOnlySettings from '@/systems/client-only-settings.client'
import * as ConfigClient from '@/systems/config.client'
import * as SettingsClient from '@/systems/settings.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as UPClient from '@/systems/user-presence.client'
import * as UsersClient from '@/systems/users.client'
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
		// dispatch silently drops ops until the config and logged-in user are known, which on a
		// fresh page load can resolve after onEnter fires
		void (async () => {
			try {
				await Promise.all([ConfigClient.fetchConfig(), UsersClient.fetchLoggedInUser()])
			} catch {
				return
			}
			UPClient.Actions.updateActivity(
				{ code: 'enter-server-dashboard', serverId: params.serverId },
				{ code: 'set-primary-panel', to: ClientOnlySettings.Store.getState().primaryPanelTab },
			)
		})()
		SquadServerClient.SelectedServerActions.setSelectedServer(params.serverId)
	},

	onLeave() {
		UPClient.Actions.dispatch({ code: 'navigated-away' })
	},
})

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
		// -------- schedule presence updates, keep default server id up-to-date --------
		const timeout$ = Rx.of(false).pipe(Rx.delay(UP.INTERACT_TIMEOUT))
		const interaction$ = Browser.userIsActive$.pipe(
			Rx.scan((acc) => acc + 1, 0),
			Rx.audit(t => t === 1 ? Rx.of(true) : Rx.of(true).pipe(Rx.delay(2000))),
			Rx.switchMap(() => Rx.concat(Rx.of(true), timeout$)),
		)
		const sub = new Rx.Subscription()

		sub.add(interaction$.subscribe((active) => {
			try {
				if (active) {
					// if the user comes back to this page we want to set this as the default server again
					SquadServerClient.SelectedServerActions.setAsDefaultServer()
					UPClient.Actions.dispatch({ code: 'page-interaction' })
				} else {
					UPClient.Actions.dispatch({ code: 'interaction-timeout' })
				}
			} catch (error) {
				console.error('Error in pushing pageInteraction$', error)
			}
		}))

		return () => {
			sub.unsubscribe()
		}
	}, [canRenderDashboard])

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
									? 'This server is currently disabled and can\'t be loaded right now.'
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
											Go Back Home
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
