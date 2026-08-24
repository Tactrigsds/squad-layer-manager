import { createFileRoute } from '@tanstack/react-router'

import TutorialsPage from '@/components/tutorials-page'

export const Route = createFileRoute('/_app/tutorials')({
	component: TutorialsPage,
})
