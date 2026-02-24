import ServerDashboard from '@/components/server-dashboard'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { globalToast$ } from '@/hooks/use-global-toast'
import * as Browser from '@/lib/browser'
import * as SS from '@/models/server-state.models'
import * as PresenceActions from '@/models/user-presence/actions'
import * as ConfigClient from '@/systems/config.client'
import * as ServerSettingsClient from '@/systems/server-settings.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as UPClient from '@/systems/user-presence.client'
import { createFileRoute, Link } from '@tanstack/react-router'
import { AlertCircle, Home } from 'lucide-react'
import React from 'react'
import * as Rx from 'rxjs'

export const Route = createFileRoute('/_app/servers/$serverId')({
	component: RouteComponent,

	loader: async ({ params }) => {
		const config = await ConfigClient.fetchConfig()
		const serverConfig = config.servers.find(s => s.id === params.serverId)
		return {
			displayName: serverConfig?.displayName ?? params.serverId,
			serverFound: serverConfig !== undefined,
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
		UPClient.PresenceStore.getState().pushPresenceAction(PresenceActions.navigatedAway)
	},
})

function RouteComponent() {
	const serverId = Route.useParams().serverId
	const serverFound = Route.useLoaderData().serverFound
	const config = ConfigClient.useConfig()
	React.useEffect(() => {
		if (!serverFound) {
			return
		}
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
				if (active) {
					// if the user comes back to this page we want to set this as the default server again
					SquadServerClient.SelectedServerStore.getState().setAsDefaultServer()
					UPClient.PresenceStore.getState().pushPresenceAction(PresenceActions.pageInteraction)
				} else {
					UPClient.PresenceStore.getState().pushPresenceAction(PresenceActions.interactionTimeout)
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
						{config && config.servers.length > 0
							? (
								<div className="space-y-3">
									<div className="text-sm font-medium text-muted-foreground">Available servers:</div>
									<div className="space-y-2">
										{config.servers.map((server) => (
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

	return <ServerDashboard />
}
