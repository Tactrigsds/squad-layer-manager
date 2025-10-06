import * as F from '@/models/filter.models'
import * as Zus from 'zustand'
import { Alert, AlertDescription, AlertTitle } from './ui/alert'

export function FilterValidationErrorDisplay(props: { store: Zus.StoreApi<F.NodeValidationErrorStore> }) {
	const extraErrors = Zus.useStore(props.store, state => state.errors)
	if (!extraErrors) return null
	return (
		<div className="mt-4 space-y-2">
			{extraErrors.map((error, index) => (
				<Alert key={index} variant="destructive">
					<AlertTitle>{error.path.slice(1).join('.')}</AlertTitle>
					<AlertDescription>{error.msg}</AlertDescription>
				</Alert>
			))}
		</div>
	)
}
