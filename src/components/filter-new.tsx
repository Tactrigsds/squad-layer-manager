import { useNavigate } from '@tanstack/react-router'
import * as Icons from 'lucide-react'
import React from 'react'

import { EditDetailsButton, EditDetailsDialog } from '@/components/edit-details-dialog'
import EmojiDisplay from '@/components/emoji-display'
import { FilterDetailsForm } from '@/components/filter-details-form'
import { MarkdownDescription } from '@/components/markdown-description'
import { PermissionDeniedTooltip } from '@/components/permission-denied-tooltip'
import * as Typo from '@/components/typography'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import * as EditFrame from '@/frames/filter-editor.frame.ts'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as F_Msgs from '@/messages/filter.messages'
import { tr } from '@/systems/messages.client'
import * as RbacClient from '@/systems/rbac.client'

import FilterCard from './filter-card'
import { FilterProblemCountBadge, FilterValidationErrorDisplay } from './filter-extra-errors'
import LayerTable from './layer-table'

// The page of a filter that has not been created yet. Its details dialog opens with the page, and can be closed to
// edit the filter first. Create opens it again while the name or the ID is missing.
export default function FilterNew(props: { stores: EditFrame.KeyProp }) {
	const { stores } = props
	const navigate = useNavigate()
	const [detailsOpen, setDetailsOpen] = React.useState(true)
	const [creating, setCreating] = React.useState(false)
	const meta = Zus.useStore(stores.filterEditor, (s) => s.meta)
	const isValidFilter = Zus.useStore(stores.filterEditor, (s) => s.valid)
	const createDenied = RbacClient.useAccess('filters.createFilter')

	const create = async () => {
		const state = Zus.getState(stores.filterEditor)
		if (!EditFrame.Actions.detailsComplete(state)) {
			setDetailsOpen(true)
			return
		}
		setCreating(true)
		try {
			if (await EditFrame.Actions.create(stores)) {
				void navigate({ to: `/filters/$filterId`, params: { filterId: state.createId } })
			}
		} finally {
			setCreating(false)
		}
	}

	return (
		<div className="container mx-auto flex flex-col gap-2">
			<header className="flex flex-col gap-2">
				<span className="flex items-center gap-x-4">
					{meta.emoji && (
						<>
							<EmojiDisplay emoji={meta.emoji} className="text-3xl" />
							<Icons.Dot />
						</>
					)}
					<h3 className={cn(Typo.H3, !meta.name && 'text-muted-foreground')}>{meta.name || tr.text(F_Msgs.newFilter())}</h3>
					<Icons.Dot />
					<EditDetailsButton denied={createDenied} onClick={() => setDetailsOpen(true)} />
				</span>
				<Separator orientation="horizontal" />
			</header>
			<EditDetailsDialog
				open={detailsOpen}
				onOpenChange={setDetailsOpen}
				title={tr.text(F_Msgs.newFilter())}
				description={tr.text(F_Msgs.newDetailsDialogBlurb())}
				className="max-w-5xl"
			>
				<FilterDetailsForm stores={stores} creating onClose={() => setDetailsOpen(false)} />
			</EditDetailsDialog>
			<FilterCard
				stores={stores}
				header={
					<>
						<MarkdownDescription description={meta.description} />
						<FilterValidationErrorDisplay stores={stores} />
					</>
				}
			>
				<FilterProblemCountBadge stores={stores} />
				<PermissionDeniedTooltip denied={createDenied}>
					<Button variant="primary" onClick={() => void create()} disabled={!isValidFilter || creating || !!createDenied}>
						<Icons.Save />
						{tr.text(F_Msgs.create())}
					</Button>
				</PermissionDeniedTooltip>
			</FilterCard>
			<LayerTable stores={{ layerTable: stores.filterEditor }} />
		</div>
	)
}
