import { Link } from '@tanstack/react-router'
import * as Icons from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as APP_Msgs from '@/messages/app.messages'
import { tr } from '@/systems/messages.client'
import * as SettingsClient from '@/systems/settings.client'

export default function ManagedServersCard({ className }: { className?: string }) {
	const settings = Zus.useStore(SettingsClient.PublicSettingsStore)
	const servers = settings?.servers ?? []

	return (
		<Card className={className}>
			<CardHeader>
				<CardTitle>{tr.text(APP_Msgs.managedServers())}</CardTitle>
			</CardHeader>
			<CardContent className="space-y-2">
				{servers.length === 0 && <p className="text-sm text-muted-foreground">{tr.text(APP_Msgs.noServersAvailable())}</p>}
				{servers.map((server) => {
					const serverId = server.id
					const usable = SettingsClient.isServerUsable(server)
					const button = (
						<Button variant="outline" className="w-full justify-start" size="lg" disabled={!usable}>
							<Icons.Server className="mr-2 h-4 w-4" />
							{server.displayName}
							<Icons.Dot className={cn('ml-auto h-6 w-6', usable ? 'text-green-500' : 'text-red-500')} />
						</Button>
					)
					// disabled/broken servers have no usable dashboard, so render a static button instead of a link
					return usable ? (
						<Link key={serverId} to="/servers/$serverId" params={{ serverId }}>
							{button}
						</Link>
					) : (
						<div key={serverId}>{button}</div>
					)
				})}
			</CardContent>
		</Card>
	)
}
