import { createFileRoute } from '@tanstack/react-router'

import ManagedServersCard from '@/components/managed-servers-card'

export const Route = createFileRoute('/_app/servers/')({
	component: RouteComponent,
})

function RouteComponent() {
	return (
		<div className="w-full max-w-lg mx-auto py-6">
			<ManagedServersCard />
		</div>
	)
}
