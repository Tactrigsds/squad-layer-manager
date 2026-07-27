import { Link } from '@tanstack/react-router'
import { AlertCircle, Home, Loader2 } from 'lucide-react'
import React from 'react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import * as Zus from '@/lib/zustand'
import * as SS_Msgs from '@/messages/server-state.messages'
import * as SettingsClient from '@/systems/settings.client'
import type * as SquadServerClient from '@/systems/squad-server.client'

type Status = Exclude<SquadServerClient.ServerAvailability, 'ok'>

// how long a server may sit enabled-but-not-running before we stop calling it "starting". A managed server that dies on a fatal
// resource error is torn down and not retried, so it would otherwise spin here forever.
const SLOW_START_MS = 20_000

// the dashboard swaps itself back in as soon as the managed server appears (see useServerAvailability), so this is a waiting
// state, not a dead end: enabling the server upgrades this view into the dashboard without a reload.
function ServerStarting(props: { displayName: string }) {
	const [slow, setSlow] = React.useState(false)
	React.useEffect(() => {
		const handle = setTimeout(() => setSlow(true), SLOW_START_MS)
		return () => clearTimeout(handle)
	}, [])

	return (
		<div className="flex items-center justify-center min-h-screen p-4 w-full">
			<Card className="w-full max-w-lg">
				<CardHeader className="text-center pb-4">
					<CardTitle className="flex items-center justify-center gap-2 text-2xl">
						<Loader2 className="h-5 w-5 animate-spin" />
						{SS_Msgs.startingTitle(props.displayName).text()}
					</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					<p className="text-sm text-muted-foreground text-center">{SS_Msgs.startingBlurb().text()}</p>
					{slow && (
						<Alert variant="destructive">
							<AlertCircle className="h-4 w-4" />
							<AlertTitle>{SS_Msgs.startingSlowTitle().text()}</AlertTitle>
							<AlertDescription>{SS_Msgs.startingSlowBlurb().text()}</AlertDescription>
						</Alert>
					)}
				</CardContent>
			</Card>
		</div>
	)
}

export default function ServerUnavailable(props: { serverId: string; status: Status }) {
	const settings = Zus.useStore(SettingsClient.PublicSettingsStore)
	const serverConfig = settings?.servers.find((s) => s.id === props.serverId)
	const displayName = serverConfig?.displayName ?? props.serverId

	if (props.status === 'starting') return <ServerStarting displayName={displayName} />
	return <UnavailableCard serverId={props.serverId} status={props.status} displayName={displayName} />
}

function UnavailableCard(props: { serverId: string; status: Exclude<Status, 'starting'>; displayName: string }) {
	const settings = Zus.useStore(SettingsClient.PublicSettingsStore)
	const otherServers = settings?.servers.filter((s) => SettingsClient.isServerUsable(s) && s.id !== props.serverId) ?? []

	return (
		<div className="flex items-center justify-center min-h-screen p-4 w-full">
			<Card className="w-full max-w-lg">
				<CardHeader className="text-center pb-4">
					<CardTitle className="text-2xl">{SS_Msgs.unavailableTitle(props.status, props.displayName).text()}</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					<Alert variant="destructive">
						<AlertCircle className="h-4 w-4" />
						<AlertTitle>{SS_Msgs.unavailableHeading().text()}</AlertTitle>
						<AlertDescription>{SS_Msgs.unavailableDescriptions[props.status]}</AlertDescription>
					</Alert>
					{otherServers.length > 0 ? (
						<div className="space-y-3">
							<div className="text-sm font-medium text-muted-foreground">{SS_Msgs.otherServersHeading().text()}</div>
							<div className="space-y-2">
								{otherServers.map((server) => (
									<Link key={server.id} to="/servers/$serverId" params={{ serverId: server.id }}>
										<Button variant="outline" className="w-full justify-start" size="lg">
											<Home className="mr-2 h-4 w-4" />
											{server.displayName}
										</Button>
									</Link>
								))}
							</div>
						</div>
					) : (
						<div className="pt-2">
							<Link to="/" className="block">
								<Button className="w-full" size="lg">
									<Home className="mr-2 h-4 w-4" />
									{SS_Msgs.backToServersList().text()}
								</Button>
							</Link>
						</div>
					)}
				</CardContent>
			</Card>
		</div>
	)
}
