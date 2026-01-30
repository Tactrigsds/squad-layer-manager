import { LoaderCircle } from 'lucide-react'

export default function FullPageSpinner() {
	return (
		<div className="pointer-events-none fixed left-0 top-0 grid h-screen w-screen place-items-center overflow-hidden">
			<LoaderCircle className="mr-2 h-16 w-16 animate-spin"></LoaderCircle>
		</div>
	)
}
