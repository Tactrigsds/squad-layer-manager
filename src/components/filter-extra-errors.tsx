import { useFrameStore } from '@/frames/frame-manager'
import type * as FRM from '@/lib/frame'
import type * as F from '@/models/filter.models'
import { Alert, AlertDescription, AlertTitle } from './ui/alert'

export function FilterValidationErrorDisplay(props: { frameKey: FRM.InstanceKey<FRM.PartialType<F.NodeValidationErrorStore>> }) {
	const extraErrors = useFrameStore(props.frameKey, state => state.errors)
	if (!extraErrors) return null
	return (
		<div className="mt-4 space-y-2">
			{extraErrors.map((error, index) => (
				<Alert key={`${error.msg}${index}`} variant="destructive">
					<AlertTitle>{error.path.slice(1).join('.')}</AlertTitle>
					<AlertDescription>{error.msg}</AlertDescription>
				</Alert>
			))}
		</div>
	)
}
