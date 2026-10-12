import * as Icons from 'lucide-react'
import React from 'react'

import * as EditFrame from '@/frames/filter-editor.frame.ts'
import { useFrameLifecycle, useFrameTeardownOnUnmount } from '@/frames/frame-manager'
import * as Zus from '@/lib/zustand'
import * as F_Msgs from '@/messages/filter.messages'
import * as EFB from '@/models/editable-filter-builders.models'
import * as F from '@/models/filter.models'
import type * as LQY from '@/models/layer-queries.models'
import { tr } from '@/systems/messages.client'

import FilterCard from './filter-card'
import { Button } from './ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible'

// The miss exemption as a field of the filter details form. Its tree is edited in a filter editor frame of its own,
// which is never shared: the exemption reaches the shared draft with the rest of the details, when the form is saved.
export function MissExemptionEditor(props: {
	defaultValue: F.FilterNode | null
	onChange: (exemption: F.EditableFilterNode | null) => void
	colConfig: LQY.EffectiveColumnAndTableConfig
}) {
	const [input] = React.useState(() =>
		EditFrame.createInput({ startingFilter: props.defaultValue ?? EFB.or(), colConfig: props.colConfig }),
	)
	const frameKey = useFrameLifecycle(EditFrame.frame, { input })
	useFrameTeardownOnUnmount(frameKey)
	const stores: EditFrame.KeyProp = { filterEditor: frameKey }

	const onChange = props.onChange
	React.useEffect(() => {
		return Zus.resolveStore<EditFrame.FilterEditor>(frameKey).subscribe((state, prev) => {
			if (state.tree !== prev.tree) onChange(exemptionFromTree(state.tree))
		})
	}, [frameKey, onChange])

	// hidden while a query is in flight: the first one runs before the tree is validated, against every layer
	const count = Zus.useStore(frameKey, (s) =>
		s.valid && s.layerTable.answeredQuery === s.layerTable.requestedQuery ? s.layerTable.pageData?.totalCount : undefined,
	)

	return (
		<Collapsible role="group" aria-label={tr.text(F_Msgs.missExemptionTitle())} className="flex flex-col gap-2 border-t pt-3">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<CollapsibleTrigger className="group flex items-center gap-1.5 text-sm font-medium">
					<Icons.ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90 rtl:-scale-x-100" />
					{tr.text(F_Msgs.missExemptionTitle())}
				</CollapsibleTrigger>
				{count !== undefined && <span className="text-sm text-muted-foreground">{tr.text(F_Msgs.missExemptionCount(count))}</span>}
			</div>
			<p className="text-sm text-muted-foreground">{tr.text(F_Msgs.missExemptionDescription())}</p>
			<CollapsibleContent className="flex flex-col gap-2">
				<FilterCard stores={stores} builderOnly />
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="self-start text-muted-foreground"
					onClick={() => EditFrame.Actions.updateRoot(stores, F.DEFAULT_MISS_EXEMPTION)}
				>
					<Icons.RotateCcw className="rtl:-scale-x-100" />
					{tr.text(F_Msgs.missExemptionReset())}
				</Button>
			</CollapsibleContent>
		</Collapsible>
	)
}

// a root block with no conditions left is no exemption, rather than the "every layer" an empty `and` would mean
function exemptionFromTree(tree: F.FilterNodeTree): F.EditableFilterNode | null {
	const node = F.treeToFilterNode(tree)
	if (F.isEditableBlockNode(node) && node.children.length === 0) return null
	return node
}
