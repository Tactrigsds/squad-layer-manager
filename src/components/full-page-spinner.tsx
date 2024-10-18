import { LoaderCircle } from 'lucide-react'

export default function FullPageSpinner() {
	return (
		<div className="fixed top-0 left-0 w-[100vw] h-[100vh] grid place-items-center pointer-events-none overflow-hidden">
			<LoaderCircle className="mr-2 h-16 w-16 animate-spin"></LoaderCircle>
		</div>
	)
}
