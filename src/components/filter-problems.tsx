import * as Icons from 'lucide-react'
import type React from 'react'

import * as Typo from '@/components/typography'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as F_Msgs from '@/messages/filter.messages'
import * as MsgFmt from '@/messages/format'
import type * as FPM from '@/models/filter-problems.models'
import type * as F from '@/models/filter.models'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import { tr } from '@/systems/messages.client'

// The pieces every surface outside the filter editor uses to report filters that cannot be applied: a list of the
// failing nodes, a tooltip around that list, and a mark for one stored filter.

function editHref(filterId: F.FilterEntityId, node: string | null) {
	return `/filters/${filterId}${node === null ? '' : `?node=${encodeURIComponent(node)}`}`
}

function LineSubject(props: { line: FPM.ProblemLine; filters: Map<string, F.FilterEntity>; fallbackLabel?: string; links: boolean }) {
	const { line } = props
	if (line.filterId === null) {
		let label = props.fallbackLabel
		if (label === undefined) {
			switch (line.constraintType) {
				case 'installed-mods':
					label = tr.text(F_Msgs.installedModsLabel())
					break
				case 'filter-menu-items':
					label = tr.text(F_Msgs.searchConditions())
					break
				default:
					label = tr.text(F_Msgs.unsavedConditions())
			}
		}
		return <span className="font-semibold">{label}</span>
	}
	const name = filterName(props.filters, line.filterId)
	const label = line.part === 'missExemption' ? tr.text(F_Msgs.exemptionPartLabel(name)) : name
	const owner = props.links ? (
		// a plain anchor: these render inside draggable windows, whose outlet sits outside the RouterProvider
		<a href={editHref(line.filterId, line.node)} target="_blank" rel="noreferrer" className={cn(Typo.Link, 'font-semibold')}>
			{label}
		</a>
	) : (
		<span className="font-semibold">{label}</span>
	)
	if (line.viaFilterId === null) return owner
	return tr.richText(F_Msgs.problemSubjectVia(<span className="font-semibold">{filterName(props.filters, line.viaFilterId)}</span>, owner))
}

function filterName(filters: Map<string, F.FilterEntity>, filterId: F.FilterEntityId) {
	return filters.get(filterId)?.name ?? tr.text(F_Msgs.deletedFilterLabel(filterId))
}

// "filter: reason", one line per failing node. `fallbackLabel` names a node that no stored filter holds. A line
// whose node is held by `ownFilterId` itself, the filter the list is shown under, reads as the reason alone.
export function ProblemLines(props: {
	lines: FPM.ProblemLine[]
	fallbackLabel?: string
	links?: boolean
	ownFilterId?: F.FilterEntityId
	// each line reads as the reason alone, under a heading that already names what failed
	bare?: boolean
	className?: string
}) {
	const filters = FilterEntityClient.useFilterEntities()
	const links = props.links ?? true
	return (
		<ul className={cn('flex flex-col gap-0.5 whitespace-normal', props.className)}>
			{props.lines.map((line) => (
				<li key={line.key}>
					{props.bare ? (
						tr.text(line.msg)
					) : props.ownFilterId !== undefined && line.filterId === props.ownFilterId && line.viaFilterId === null ? (
						<OwnLine line={line} filterId={props.ownFilterId} links={links} />
					) : (
						tr.richText(
							F_Msgs.problemLine(
								<LineSubject line={line} filters={filters} fallbackLabel={props.fallbackLabel} links={links} />,
								line.msg,
							),
						)
					)}
				</li>
			))}
		</ul>
	)
}

function OwnLine(props: { line: FPM.ProblemLine; filterId: F.FilterEntityId; links: boolean }) {
	const { line } = props
	const reason = props.links ? (
		<a href={editHref(props.filterId, line.node)} target="_blank" rel="noreferrer" className={Typo.Link}>
			{tr.text(line.msg)}
		</a>
	) : (
		tr.text(line.msg)
	)
	if (line.part === 'filter') return reason
	return tr.richText(F_Msgs.nodeProblemLine(tr.text(F_Msgs.exemptionProblemLabel()), reason))
}

// A trigger whose tooltip explains a problem and lists the failing nodes. With links, clicking the trigger pins
// the tooltip so the links can be reached.
export function ProblemsTip(props: {
	heading: string
	lines: FPM.ProblemLine[]
	fallbackLabel?: string
	links?: boolean
	triggerClassName?: string
	// for a trigger with no text of its own
	'aria-label'?: string
	children: React.ReactNode
}) {
	const links = props.links ?? true
	return (
		<Tooltip pinnable={links}>
			<TooltipTrigger asChild>
				<span
					role={props['aria-label'] ? 'img' : undefined}
					tabIndex={0}
					aria-label={props['aria-label']}
					className={cn('inline-flex min-w-0 items-center', props.triggerClassName)}
				>
					{props.children}
				</span>
			</TooltipTrigger>
			<TooltipContent className="flex w-max max-w-[min(28rem,calc(100vw-2rem))] flex-col gap-1">
				<p>{props.heading}</p>
				<ProblemLines lines={props.lines} fallbackLabel={props.fallbackLabel} links={links} />
			</TooltipContent>
		</Tooltip>
	)
}

// one entry per broken filter of a server's configuration: the filter, what the configuration uses it for, and its
// failing nodes
export function ConfigProblemList(props: { rows: FPM.ConfigProblemRow[] }) {
	const filters = FilterEntityClient.useFilterEntities()
	return (
		<ul className="flex flex-col gap-1.5">
			{props.rows.map((row) => (
				<li key={row.key} className="flex flex-col gap-0.5">
					<span className="flex flex-wrap items-baseline gap-x-1.5">
						{row.filterId === null ? (
							<span className="font-semibold">{tr.text(F_Msgs.installedModsLabel())}</span>
						) : (
							<a href={editHref(row.filterId, null)} target="_blank" rel="noreferrer" className={cn(Typo.Link, 'font-semibold')}>
								{filterName(filters, row.filterId)}
							</a>
						)}
						{row.uses.length > 0 && (
							<span className="text-text-3">
								<span aria-hidden>{'\u00b7 '}</span>
								{MsgFmt.formatList(row.uses.map((use) => tr.text(F_Msgs.poolConfigKeyNames[use])))}
							</span>
						)}
					</span>
					<ProblemLines lines={row.lines} ownFilterId={row.filterId ?? undefined} bare={row.filterId === null} className="ps-3" />
				</li>
			))}
		</ul>
	)
}

// Beside a result count, the filters the results were computed without. Truncates rather than wraps, for toolbars
// that hold one line
export function SkippedFiltersLabel(props: { lines: FPM.ProblemLine[]; count: number; className?: string }) {
	if (props.count === 0) return null
	return (
		<ProblemsTip
			heading={tr.text(F_Msgs.notFilteredByHint())}
			lines={props.lines}
			triggerClassName={cn('gap-1 text-sm text-warn', props.className)}
		>
			<Icons.TriangleAlert className="size-3.5 shrink-0" />
			<span className="truncate">{tr.text(F_Msgs.filtersCannotBeApplied(props.count))}</span>
		</ProblemsTip>
	)
}

// On a queue item: indicators and warnings from the filters that cannot be applied are missing
export function NotCheckedMark(props: { lines: FPM.ProblemLine[] }) {
	if (props.lines.length === 0) return null
	return (
		<ProblemsTip heading={tr.text(F_Msgs.notCheckedHint())} lines={props.lines} aria-label={tr.text(F_Msgs.notChecked())}>
			<Icons.ShieldQuestion className="size-4 shrink-0 text-warn" />
		</ProblemsTip>
	)
}

// Marks a stored filter that cannot be applied, with the reasons in a tooltip. Renders nothing for a filter that
// can. `badge` spells out the problem count; the default is an icon, for places where a filter is one chip of many.
// `links` is off inside pickers, where a click selects the option.
export function FilterProblemsMark(props: { filterId: F.FilterEntityId; badge?: boolean; links?: boolean; className?: string }) {
	const summary = Zus.useStore(FilterEntityClient.ProblemsStore, FilterEntityClient.Sel.filterProblemSummary(props.filterId))
	if (summary.lines.length === 0) return null
	const count = tr.text(F_Msgs.problemCount(summary.lines.length))
	return (
		<ProblemsTip
			heading={tr.text(summary.exemptionOnly ? F_Msgs.exemptionCannotBeAppliedHint() : F_Msgs.filterCannotBeAppliedHint())}
			lines={summary.lines}
			links={props.links}
			aria-label={count}
			triggerClassName={props.className}
		>
			{props.badge ? (
				<Badge variant="destructive" className="whitespace-nowrap">
					<Icons.TriangleAlert className="size-3" />
					{count}
				</Badge>
			) : (
				<Icons.TriangleAlert className="size-3.5 shrink-0 text-destructive" />
			)}
		</ProblemsTip>
	)
}
