import { LoaderCircle } from 'lucide-react'

export default function FullPageSpinner() {
	return (
		<div className="w-full h-full grid place-items-center">
			<LoaderCircle className="mr-2 h-16 w-16 animate-spin"></LoaderCircle>
		</div>
	)
}
