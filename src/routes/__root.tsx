import { createRootRoute, Outlet } from '@tanstack/react-router'
import { HeadContent } from '@tanstack/react-router'

import * as APP_Msgs from '@/messages/app.messages'
import { tr } from '@/systems/messages.client'

export const Route = createRootRoute({
	head: () => ({
		meta: [{ title: tr.text(APP_Msgs.productName()) }],
	}),
	component: RootComponent,
})

function RootComponent() {
	return (
		<>
			<HeadContent />
			<Outlet />
		</>
	)
}
