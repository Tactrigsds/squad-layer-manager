import * as Icons from 'lucide-react'
import React from 'react'

import ComboBox, { type ComboBoxOption } from '@/components/combo-box/combo-box'
import ComboBoxMulti from '@/components/combo-box/combo-box-multi'
import { type OverrideProps, useFieldValue } from '@/components/settings-form/settings-form.helpers'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import * as Arr from '@/lib/array-utils'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as PG_Msgs from '@/messages/player-groupings.messages'
import * as TSW_Msgs from '@/messages/teamswaps.messages'
import * as PG from '@/models/player-groupings.models'
import * as TSWCB from '@/models/teamswap-counterbalance.models'
import * as BattlemetricsClient from '@/systems/battlemetrics.client'
import * as DndKit from '@/systems/dndkit.client'
import { tr } from '@/systems/messages.client'
import * as SettingsClient from '@/systems/settings.client'

const PREFERENCE_TYPES: TSWCB.Preference['type'][] = ['group', ...TSWCB.STAT_PREFERENCES]

// JSON because grouping and group names are free text
function encodeRef(ref: TSWCB.GroupRef): string {
	return JSON.stringify([ref.grouping, ref.group])
}

function decodeRef(value: string): TSWCB.GroupRef {
	const [grouping, group] = JSON.parse(value) as [string, string]
	return { grouping, group }
}

function GroupRefLabel({ grouping, group, color }: { grouping: string; group: string; color?: string }) {
	return (
		<span className="inline-flex min-w-0 items-baseline gap-1">
			<span className="text-muted-foreground">{grouping}</span>
			<span style={{ color }}>{group}</span>
		</span>
	)
}

// Every group the configured grouping modes can assign. A `kept` ref the grouping modes no longer name stays in the
// list, so a stale entry is visible rather than silently dropped on the next save.
function useGroupOptions(kept: TSWCB.GroupRef[]): ComboBoxOption<string>[] {
	const groupings = Zus.useStore(SettingsClient.PublicSettingsStore, (s) => s?.playerGroupings) ?? PG.EMPTY_PLAYER_GROUPINGS
	const orgFlags = BattlemetricsClient.useOrgFlags()
	const options: ComboBoxOption<string>[] = []
	const offered = new Set<string>()
	for (const groupingId of PG.getGroupingIds(groupings)) {
		const grouping = groupings[groupingId]
		for (const group of PG.getGroupNames(grouping)) {
			const value = encodeRef({ grouping: groupingId, group })
			offered.add(value)
			options.push({
				value,
				label: <GroupRefLabel grouping={groupingId} group={group} color={PG.getGroupColor(grouping, group, orgFlags)} />,
				keywords: [groupingId, group],
			})
		}
	}
	for (const ref of kept) {
		const value = encodeRef(ref)
		if (offered.has(value) || !ref.grouping) continue
		offered.add(value)
		options.push({ value, label: <GroupRefLabel grouping={ref.grouping} group={ref.group} />, keywords: [ref.grouping, ref.group] })
	}
	return options
}

export function CounterbalanceGroupsField({ value$, onChange }: OverrideProps) {
	const refs = (useFieldValue(value$) as TSWCB.GroupRef[] | undefined) ?? []
	const options = useGroupOptions(refs)
	const values = refs.map(encodeRef)
	return (
		<ComboBoxMulti
			title={tr.text(TSW_Msgs.groupPicker())}
			values={values}
			options={options}
			emptyLabel={tr.text(TSW_Msgs.addGroup())}
			chipDisplay
			onSelect={(next) => onChange((typeof next === 'function' ? next(values) : next).map(decodeRef))}
		/>
	)
}

// a thin gap between rows that highlights while a row is dragged over it
function PreferenceDropSeparator({ position, idx }: { position: 'before' | 'after'; idx: number }) {
	const drop = DndKit.useDroppable({
		type: 'relative-to-drag-item',
		slots: [{ position, dragItem: { type: 'counterbalance-preference', id: String(idx) } }],
	})
	return (
		<li
			ref={drop.ref}
			data-over={drop.isDropTarget}
			className="col-span-full my-0.5 h-1 rounded bg-primary data-[over=false]:invisible"
		/>
	)
}

function PreferenceRow({
	pref,
	idx,
	groupOptions,
	onReplace,
	onRemove,
}: {
	pref: TSWCB.Preference
	idx: number
	groupOptions: ComboBoxOption<string>[]
	onReplace: (pref: TSWCB.Preference) => void
	onRemove: () => void
}) {
	const drag = DndKit.useDraggable({ type: 'counterbalance-preference', id: String(idx) }, { feedback: 'default' })
	function setType(type: TSWCB.Preference['type']) {
		if (type === pref.type) return
		if (type === 'group') onReplace({ type, grouping: '', group: '' })
		else onReplace({ type, order: pref.type === 'group' ? 'lowest' : pref.order })
	}
	return (
		<li
			ref={drag.ref}
			data-dragging={drag.isDragging}
			className="col-span-full grid grid-cols-subgrid items-center rounded-md bg-background data-[dragging=true]:opacity-40"
		>
			<button
				type="button"
				ref={drag.handleRef}
				className="cursor-grab rounded text-muted-foreground"
				aria-label={tr.text(PG_Msgs.dragToReorder())}
			>
				<Icons.GripVertical className="h-4 w-4" />
			</button>
			<span className="text-xs tabular-nums text-muted-foreground">{idx + 1}.</span>
			<Select value={pref.type} onValueChange={(next) => setType(next as TSWCB.Preference['type'])}>
				<SelectTrigger className="h-8">
					{/* every label stacked in one cell, so the trigger is as wide as the widest in any locale */}
					<span className="grid">
						{PREFERENCE_TYPES.map((type) => (
							<span
								key={type}
								aria-hidden={type !== pref.type}
								className={cn('col-start-1 row-start-1', type !== pref.type && 'invisible')}
							>
								{tr.text(TSW_Msgs.preferenceLabels[type])}
							</span>
						))}
					</span>
				</SelectTrigger>
				<SelectContent>
					{PREFERENCE_TYPES.map((type) => (
						<SelectItem key={type} value={type}>
							{tr.text(TSW_Msgs.preferenceLabels[type])}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{pref.type === 'group' ? (
				<ComboBox
					title={tr.text(TSW_Msgs.groupPicker())}
					value={pref.grouping ? encodeRef(pref) : undefined}
					options={groupOptions}
					onSelect={(next) => {
						if (next) onReplace({ type: 'group', ...decodeRef(next) })
					}}
				/>
			) : (
				<Select value={pref.order} onValueChange={(next) => onReplace({ type: pref.type, order: next as TSWCB.StatOrder })}>
					<SelectTrigger className="h-8 w-auto justify-self-start">
						<span className="grid">
							{TSWCB.STAT_ORDERS.map((order) => (
								<span
									key={order}
									aria-hidden={order !== pref.order}
									className={cn('col-start-1 row-start-1', order !== pref.order && 'invisible')}
								>
									{tr.text(TSW_Msgs.orderLabels[order])}
								</span>
							))}
						</span>
					</SelectTrigger>
					<SelectContent>
						{TSWCB.STAT_ORDERS.map((order) => (
							<SelectItem key={order} value={order}>
								{tr.text(TSW_Msgs.orderLabels[order])}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			)}
			<Button
				type="button"
				size="icon"
				variant="ghost"
				className="h-6 w-6 text-destructive"
				aria-label={tr.text(TSW_Msgs.removePreference())}
				onClick={onRemove}
			>
				<Icons.X className="h-4 w-4" />
			</Button>
		</li>
	)
}

export function CounterbalancePickFirstField({ value$, onChange }: OverrideProps) {
	const prefs = (useFieldValue(value$) as TSWCB.Preference[] | undefined) ?? []
	const groupOptions = useGroupOptions(prefs.flatMap((p) => (p.type === 'group' ? [p] : [])))

	// registered once, so it reads the latest list off a ref
	const latest = React.useRef({ prefs, onChange })
	latest.current = { prefs, onChange }
	DndKit.useDragEnd(
		React.useCallback((evt) => {
			const { active, over } = evt
			if (active.type !== 'counterbalance-preference' || !over) return
			const slot = over.slots.find((s) => s.dragItem.type === 'counterbalance-preference')
			if (!slot || slot.position === 'on') return
			const { prefs, onChange } = latest.current
			onChange(Arr.moveItem(prefs, Number(active.id), Number(slot.dragItem.id), slot.position))
		}, []),
	)

	function add() {
		const unused = TSWCB.STAT_PREFERENCES.find((stat) => !prefs.some((p) => p.type === stat))
		onChange([...prefs, unused ? { type: unused, order: 'lowest' } : { type: 'group', grouping: '', group: '' }])
	}

	return (
		<div className="space-y-1.5">
			{prefs.length > 0 && (
				<ol className="grid grid-cols-[auto_1.5rem_auto_minmax(0,1fr)_auto] gap-x-2">
					{prefs.map((pref, idx) => (
						// a preference has no id of its own: its position is its priority
						// oxlint-disable-next-line no-array-index-key
						<React.Fragment key={idx}>
							<PreferenceDropSeparator position="before" idx={idx} />
							<PreferenceRow
								pref={pref}
								idx={idx}
								groupOptions={groupOptions}
								onReplace={(next) => onChange(prefs.map((p, i) => (i === idx ? next : p)))}
								onRemove={() => onChange(prefs.filter((_, i) => i !== idx))}
							/>
						</React.Fragment>
					))}
					<PreferenceDropSeparator position="after" idx={prefs.length - 1} />
				</ol>
			)}
			<Button type="button" variant="outline" size="sm" onClick={add}>
				<Icons.Plus className="me-1 h-4 w-4" />
				{tr.text(TSW_Msgs.addPreference())}
			</Button>
		</div>
	)
}
