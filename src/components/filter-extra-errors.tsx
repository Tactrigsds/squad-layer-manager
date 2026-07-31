import type * as EditFrame from '@/frames/filter-editor.frame.ts'
import * as Zus from '@/lib/zustand'
import * as F_Msgs from '@/messages/filter.messages'
import { tr } from '@/systems/messages.client'

import { Alert, AlertDescription, AlertTitle } from './ui/alert'

export function FilterValidationErrorDisplay(props: { stores: EditFrame.KeyProp }) {
	const [extraErrors, referenceCycle] = Zus.useStore(
		props.stores.filterEditor,
		Zus.useShallow((state) => [state.errors, state.referenceCycle] as const),
	)
	if (!extraErrors?.length && !referenceCycle) return null
	return (
		<div className="mt-4 space-y-2">
			{referenceCycle && (
				<Alert variant="destructive">
					<AlertTitle>{tr.text(F_Msgs.referencesHeading())}</AlertTitle>
					<AlertDescription>{tr.text(F_Msgs.cyclicalReferenceBlurb(referenceCycle.join(' -> ')))}</AlertDescription>
				</Alert>
			)}
			{extraErrors?.map((error) => (
				<Alert key={error.path.join('.')} variant="destructive">
					<AlertTitle>{error.path.slice(1).join('.')}</AlertTitle>
					<AlertDescription>{tr.text(error.msg)}</AlertDescription>
				</Alert>
			))}
		</div>
	)
}
