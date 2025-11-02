import { useFrameStore } from '@/frames/frame-manager'
import * as FRM from '@/lib/frame'
import * as F from '@/models/filter.models'
import * as Zus from 'zustand'
import { Alert, AlertDescription, AlertTitle } from './ui/alert'

export function FilterValidationErrorDisplay(props: { frameKey: FRM.InstanceKey<FRM.PartialType<F.NodeValidationErrorStore>> }) {
	const extraErrors = useFrameStore(props.frameKey, state => state.errors)
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
