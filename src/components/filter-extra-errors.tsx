import type * as EditFrame from '@/frames/filter-editor.frame.ts'
import * as ZusUtils from '@/lib/zustand'
import { Alert, AlertDescription, AlertTitle } from './ui/alert'

export function FilterValidationErrorDisplay(props: { stores: EditFrame.KeyProp }) {
	const extraErrors = ZusUtils.useStore(props.stores.filterEditor, state => state.errors)
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
