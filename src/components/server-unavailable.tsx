import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { assertNever } from '@/lib/type-guards'
import * as ZusUtils from '@/lib/zustand'
import * as SettingsClient from '@/systems/settings.client'
import type * as SquadServerClient from '@/systems/squad-server.client'
import { Link } from '@tanstack/react-router'
import { AlertCircle, Home, Loader2 } from 'lucide-react'
import React from 'react'

type Status = Exclude<SquadServerClient.ServerAvailability, 'ok'>

function describe(status: Exclude<Status, 'starting'>, displayName: string) {
	switch (status) {
		case 'not-found':
			return {
				title: `Server "${displayName}" Not Found`,
				description: 'This server may have been removed from the configuration, or the server ID is incorrect.',
			}
		case 'disabled':
			return {
				title: `Server "${displayName}" Disabled`,
				description: "This server is disabled, so it isn't running. If you have access, you can enable it on the settings page.",
			}
		case 'broken':
			return {
				title: `Server "${displayName}" Has Invalid Settings`,
				description:
					"This server's settings failed validation, so it can't be started. Repair them on the settings page, then enable the server.",
			}
		default:
			assertNever(status)
	}
}

// how long a server may sit enabled-but-not-running before we stop calling it "starting". A slice that dies on a fatal
// resource error is torn down and not retried, so it would otherwise spin here forever.
const SLOW_START_MS = 20_000

// the dashboard swaps itself back in as soon as the slice appears (see useServerAvailability), so this is a waiting
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
						Starting "{props.displayName}"
					</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					<p className="text-sm text-muted-foreground text-center">
						Waiting for the server to come online. This page will switch to the dashboard on its own.
					</p>
					{slow && (
						<Alert variant="destructive">
							<AlertCircle className="h-4 w-4" />
							<AlertTitle>This is taking longer than expected</AlertTitle>
							<AlertDescription>
								The server still hasn't come online. It may have failed to start, in which case the logs will say why.
							</AlertDescription>
						</Alert>
					)}
				</CardContent>
			</Card>
		</div>
	)
}

export default function ServerUnavailable(props: { serverId: string; status: Status }) {
	const settings = ZusUtils.useStore(SettingsClient.PublicSettingsStore)
	const serverConfig = settings?.servers.find(s => s.id === props.serverId)
	const displayName = serverConfig?.displayName ?? props.serverId

	if (props.status === 'starting') return <ServerStarting displayName={displayName} />
	return <UnavailableCard serverId={props.serverId} status={props.status} displayName={displayName} />
}

function UnavailableCard(props: { serverId: string; status: Exclude<Status, 'starting'>; displayName: string }) {
	const settings = ZusUtils.useStore(SettingsClient.PublicSettingsStore)
	const { title, description } = describe(props.status, props.displayName)
	const otherServers = settings?.servers.filter(s => SettingsClient.isServerUsable(s) && s.id !== props.serverId) ?? []

	return (
		<div className="flex items-center justify-center min-h-screen p-4 w-full">
			<Card className="w-full max-w-lg">
				<CardHeader className="text-center pb-4">
					<CardTitle className="text-2xl">{title}</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					<Alert variant="destructive">
						<AlertCircle className="h-4 w-4" />
						<AlertTitle>What happened?</AlertTitle>
						<AlertDescription>{description}</AlertDescription>
					</Alert>
					{otherServers.length > 0
						? (
							<div className="space-y-3">
								<div className="text-sm font-medium text-muted-foreground">Available servers:</div>
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
