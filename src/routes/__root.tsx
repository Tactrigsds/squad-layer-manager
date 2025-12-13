import { Providers } from '@/components/providers.tsx'
import { createRootRoute, Outlet } from '@tanstack/react-router'
import { HeadContent } from '@tanstack/react-router'
import * as React from 'react'

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{ title: 'Squad Layer Manager' },
		],
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
