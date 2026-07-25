import { createFileRoute } from '@tanstack/react-router'

import CommandsPage from '@/components/commands-page'

export const Route = createFileRoute('/_app/commands')({
	component: CommandsPage,
})
