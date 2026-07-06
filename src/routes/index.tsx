import * as ZusUtils from '@/lib/zustand'
import * as SquadServerClient from '@/systems/squad-server.client'
import { createFileRoute, Navigate } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
	component: RouteComponent,
})

function RouteComponent() {
	const serverId = ZusUtils.useStore(SquadServerClient.SelectedServerStore, s => s.selectedServerId)
	// the backend sets the default-server-id cookie when a default server exists; if it's absent there's no
	// server to route to, so send the user to the server list instead of /servers/undefined
	if (!serverId) return <Navigate to="/servers" />
	return <Navigate to="/servers/$serverId" params={{ serverId }} />
}
