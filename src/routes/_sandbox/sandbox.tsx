import { HeadlessDialogExample } from '@/components/ui/headless-dialog-example'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_sandbox/sandbox')({
	component: RouteComponent,
})

function RouteComponent() {
	return (
		<span className="w-[100vw] h-[100vh] grid place-items-center">
			<HeadlessDialogExample />
		</span>
	)
}
