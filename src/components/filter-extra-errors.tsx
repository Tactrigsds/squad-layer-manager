import { Link } from '@tanstack/react-router'

import * as Typo from '@/components/typography'
import * as EditFrame from '@/frames/filter-editor.frame.ts'
import { assertNever } from '@/lib/type-guards'
import * as Zus from '@/lib/zustand'
import * as F_Msgs from '@/messages/filter.messages'
import type * as F from '@/models/filter.models'
import * as ConfigClient from '@/systems/config.client'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import { tr } from '@/systems/messages.client'

import { NodeSummary } from './filter-card'
import { Alert, AlertDescription, AlertTitle } from './ui/alert'
import { Badge } from './ui/badge'

// `exemptions` is the miss exemption's own editor, whose tree is the exemption rather than a filter
export function FilterValidationErrorDisplay(props: { stores: EditFrame.KeyProp; tree?: 'filter' | 'exemptions' }) {
	const [rows, referenceCycle] = Zus.useStore(
		props.stores.filterEditor,
		Zus.useShallow((state) => [EditFrame.Sel.problemRows(state), state.referenceCycle] as const),
	)
	if (rows.length === 0 && !referenceCycle) return null
	const exemptions = props.tree === 'exemptions'
	return (
		<div className="mt-4 space-y-2">
			{referenceCycle && (
				<Alert variant="destructive">
					<AlertTitle>{tr.text(F_Msgs.referencesHeading())}</AlertTitle>
					<AlertDescription>{tr.text(F_Msgs.cyclicalReferenceBlurb(referenceCycle.join(' -> ')))}</AlertDescription>
				</Alert>
			)}
			{rows.length > 0 && (
				<Alert variant="destructive" aria-label={tr.text(exemptions ? F_Msgs.exemptionProblemsTitle() : F_Msgs.editorProblemsTitle())}>
					<AlertTitle>{tr.text(exemptions ? F_Msgs.exemptionProblemsTitle() : F_Msgs.editorProblemsTitle())}</AlertTitle>
					<AlertDescription>
						<p>{tr.text(exemptions ? F_Msgs.exemptionProblemsBlurb() : F_Msgs.editorProblemsBlurb())}</p>
						<ul className="mt-1 flex flex-col gap-1">
							{rows.map((row) => (
								<li key={row.key}>
									<ProblemLine row={row} stores={props.stores} />
								</li>
							))}
						</ul>
					</AlertDescription>
				</Alert>
			)}
		</div>
	)
}

function ProblemLine(props: { row: EditFrame.ProblemRow; stores: EditFrame.KeyProp }) {
	const row = props.row
	switch (row.type) {
		case 'node': {
			if (row.nodeId === null) {
				if (row.error.part === 'missExemption') {
					return tr.richText(F_Msgs.nodeProblemLine(tr.text(F_Msgs.exemptionProblemLabel()), tr.text(row.error.msg)))
				}
				return tr.text(row.error.msg)
			}
			// the whole line is the button, so its name says what is wrong as well as where
			return (
				<button
					type="button"
					className="text-start hover:underline"
					onClick={() => EditFrame.Actions.revealNode(props.stores, row.nodeId!)}
				>
					{tr.richText(F_Msgs.nodeProblemLine(<NodeLabel nodeId={row.nodeId} stores={props.stores} />, tr.text(row.error.msg)))}
				</button>
			)
		}
		case 'referenced': {
			const reason = <ReferencedProblems ownerFilterId={row.ownerFilterId} errors={row.errors} />
			if (row.nodeId === null) return reason
			const nodeId = row.nodeId
			return tr.richText(
				F_Msgs.nodeProblemLine(
					<button
						type="button"
						className="text-start hover:underline"
						onClick={() => EditFrame.Actions.revealNode(props.stores, nodeId)}
					>
						<NodeLabel nodeId={nodeId} stores={props.stores} />
					</button>,
					reason,
				),
			)
		}
		default:
			assertNever(row)
	}
}

function NodeLabel(props: { nodeId: string; stores: EditFrame.KeyProp }) {
	const node = Zus.useStore(props.stores.filterEditor, EditFrame.Sel.nodeIfPresent(props.nodeId))
	const marks = Zus.useStore(props.stores.filterEditor, EditFrame.Sel.nodeMarks(props.nodeId))
	const cfg = ConfigClient.useEffectiveColConfig()
	if (!node) return null
	return <NodeSummary node={node} cfg={cfg} marks={marks} />
}

function ReferencedProblems(props: { ownerFilterId: F.FilterEntityId; errors: F.NodeValidationError[] }) {
	const owner = FilterEntityClient.useFilterEntities().get(props.ownerFilterId)
	const path = props.errors[0].path.join('.')
	return tr.richText(
		F_Msgs.referencedFilterProblems(
			<Link to="/filters/$filterId" params={{ filterId: props.ownerFilterId }} search={path ? { node: path } : {}} className={Typo.Link}>
				{owner?.name ?? props.ownerFilterId}
			</Link>,
			props.errors.length,
		),
	)
}

export function FilterProblemCountBadge(props: { stores: EditFrame.KeyProp }) {
	const count = Zus.useStore(props.stores.filterEditor, EditFrame.Sel.problemCount)
	if (count === 0) return null
	return (
		<Badge variant="destructive" className="text-nowrap">
			{tr.text(F_Msgs.problemCount(count))}
		</Badge>
	)
}
