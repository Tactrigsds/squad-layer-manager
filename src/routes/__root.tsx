import { createRootRoute, Outlet } from '@tanstack/react-router'
import { HeadContent } from '@tanstack/react-router'

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
