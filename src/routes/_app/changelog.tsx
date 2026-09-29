import { createFileRoute } from '@tanstack/react-router'

import ChangelogPage from '@/components/changelog-page'

export const Route = createFileRoute('/_app/changelog')({
	component: ChangelogPage,
})
