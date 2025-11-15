import { Providers } from '@/components/providers.tsx'
import { createRootRoute, Outlet } from '@tanstack/react-router'
import * as React from 'react'

export const Route = createRootRoute({
	component: RootComponent,
})

function RootComponent() {
	return (
		<Providers>
			<Outlet />
		</Providers>
	)
}
