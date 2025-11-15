import * as SquadServerClient from '@/systems.client/squad-server.client'
import { createFileRoute, Navigate } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
	component: RouteComponent,
})

function RouteComponent() {
	const serverId = SquadServerClient.useSelectedServerId()
	return <Navigate to="/servers/$serverId" params={{ serverId }} />
}
