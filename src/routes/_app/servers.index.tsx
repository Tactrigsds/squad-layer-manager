import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import * as ZusUtils from '@/lib/zustand'
import * as SettingsClient from '@/systems/settings.client'
import { createFileRoute, Link } from '@tanstack/react-router'
import * as Icons from 'lucide-react'

export const Route = createFileRoute('/_app/servers/')({
	component: RouteComponent,
})

function RouteComponent() {
	const settings = ZusUtils.useStore(SettingsClient.PublicSettingsStore)
	const servers = settings?.servers.filter(s => s.enabled) ?? []

	return (
		<div className="w-full max-w-lg mx-auto py-6">
			<Card>
				<CardHeader>
					<CardTitle>Servers</CardTitle>
				</CardHeader>
				<CardContent className="space-y-2">
					{servers.length === 0 && <p className="text-sm text-muted-foreground">No servers available.</p>}
					{servers.map(server => (
						<Link key={server.id} to="/servers/$serverId" params={{ serverId: server.id }}>
							<Button variant="outline" className="w-full justify-start" size="lg">
								<Icons.Server className="mr-2 h-4 w-4" />
								{server.displayName}
							</Button>
						</Link>
					))}
				</CardContent>
			</Card>
		</div>
	)
}
