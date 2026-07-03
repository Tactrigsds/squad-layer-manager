import * as ZusUtils from '@/lib/zustand'
import * as SquadServerClient from '@/systems/squad-server.client'
import { createFileRoute, Navigate } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
	component: RouteComponent,
})

function RouteComponent() {
	const serverId = ZusUtils.useStore(SquadServerClient.SelectedServerStore, s => s.selectedServerId)
	return <Navigate to="/servers/$serverId" params={{ serverId }} />
}
