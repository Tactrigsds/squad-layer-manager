import CommandsPage from '@/components/commands-page'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/commands')({
	component: CommandsPage,
})
