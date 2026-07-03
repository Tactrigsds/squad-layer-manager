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
		const serverFound = serverConfig !== undefined
		return {
			displayName: serverConfig?.displayName ?? params.serverId,
			serverFound,
			squadServerFrameKey: serverFound
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
		UPClient.Actions.updateActivity(
			{ code: 'enter-server-dashboard', serverId: params.serverId },
			{ code: 'set-primary-panel', to: 'VIEWING_QUEUE' },
		)
		SquadServerClient.SelectedServerActions.setSelectedServer(params.serverId)
	},

	onLeave() {
		UPClient.Actions.dispatch({ code: 'navigated-away' })
	},
})

function RouteComponent() {
	const serverId = Route.useParams().serverId
	const { serverFound, squadServerFrameKey } = Route.useLoaderData()
	const settings = ZusUtils.useStore(SettingsClient.PublicSettingsStore)
	React.useEffect(() => {
		if (!serverFound) {
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
	}, [serverFound])

	if (!serverFound) {
		return (
			<div className="flex items-center justify-center min-h-screen p-4 w-full">
				<Card className="w-full max-w-lg">
					<CardHeader className="text-center pb-4">
						<CardTitle className="text-2xl">
							Server "{serverId}" Not Found
						</CardTitle>
					</CardHeader>
					<CardContent className="space-y-4">
						<Alert variant="destructive">
							<AlertCircle className="h-4 w-4" />
							<AlertTitle>What happened?</AlertTitle>
							<AlertDescription>
								This server may have been removed from the configuration or the server ID is incorrect.
							</AlertDescription>
						</Alert>
						{settings && settings.servers.some(s => s.enabled)
							? (
								<div className="space-y-3">
									<div className="text-sm font-medium text-muted-foreground">Available servers:</div>
									<div className="space-y-2">
										{settings.servers.filter(s => s.enabled).map((server) => (
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
