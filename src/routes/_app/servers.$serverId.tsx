import LayerQueueDashboard from '@/components/layer-queue-dashboard'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/servers/$serverId')({
	component: RouteComponent,
	onEnter: ({ params }) => {
	},
})

function RouteComponent() {
	return <LayerQueueDashboard />
}
