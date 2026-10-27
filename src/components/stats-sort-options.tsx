import { statMetricLabel } from '@/components/stats-sort-options.helpers'
import { cn } from '@/lib/utils'
import * as SM_Msgs from '@/messages/squad.messages'
import * as CHAT from '@/models/chat.models'
import { tr } from '@/systems/messages.client'

export type StatsSortPick<K extends string> = { scope: CHAT.StatsSortScope; key: K | CHAT.StatMetric; desc: boolean }

// The body of a stats sort popover: players or squads, the stat or extra key to sort by, and the direction. A null
// `scope` means no sort is active, so nothing is lit; picking anything then sorts highest first.
export function StatsSortOptions<K extends string>(props: {
	scope: CHAT.StatsSortScope | null
	sortKey: K | CHAT.StatMetric
	desc: boolean
	extraKeys?: { key: K; label: string }[]
	onPick: (pick: StatsSortPick<K>) => void
	onClear: () => void
}) {
	const { scope, sortKey, desc } = props
	const pick = (change: Partial<StatsSortPick<K>>) =>
		props.onPick({ scope: scope ?? 'players', key: sortKey, desc: scope === null ? true : desc, ...change })
	const keys: { key: K | CHAT.StatMetric; label: string }[] = [
		...CHAT.STAT_METRICS.map((m) => ({ key: m, label: tr.text(statMetricLabel(m)) })),
		...(props.extraKeys ?? []),
	]
	return (
		<div className="flex flex-col gap-0.5">
			<div className="flex gap-0.5">
				{(['players', 'squads'] as const).map((s) => (
					<button
						key={s}
						type="button"
						className={pillClass(scope === s)}
						title={s === 'squads' ? tr.text(SM_Msgs.sortSquadsScopeHint()) : undefined}
						onClick={() => pick({ scope: s })}
					>
						{tr.text(s === 'players' ? SM_Msgs.sortPlayersScope() : SM_Msgs.sortSquadsScope())}
					</button>
				))}
			</div>
			<div className="flex flex-wrap gap-0.5">
				{keys.map(({ key, label }) => (
					<button key={key} type="button" className={pillClass(scope !== null && sortKey === key)} onClick={() => pick({ key })}>
						{label}
					</button>
				))}
			</div>
			<div className="flex gap-0.5">
				{(['desc', 'asc'] as const).map((dir) => (
					<button
						key={dir}
						type="button"
						className={pillClass(scope !== null && desc === (dir === 'desc'))}
						onClick={() => pick({ desc: dir === 'desc' })}
					>
						{tr.text(dir === 'desc' ? SM_Msgs.sortDescending() : SM_Msgs.sortAscending())}
					</button>
				))}
				<button
					type="button"
					className="text-xs px-2 py-0.5 rounded text-muted-foreground hover:text-foreground ms-auto"
					onClick={props.onClear}
				>
					{tr.text(SM_Msgs.clearFilter())}
				</button>
			</div>
		</div>
	)
}

function pillClass(active: boolean) {
	return cn('text-xs px-2 py-0.5 rounded', active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')
}
