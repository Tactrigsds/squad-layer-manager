import ComboBox from '@/components/combo-box/combo-box'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { useDebounced } from '@/hooks/use-debounce'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import * as DndKit from '@/systems/dndkit.client'
import * as Icons from 'lucide-react'
import React from 'react'
import type * as Rx from 'rxjs'

type Config = LC.LayerGenerationConfig
type WeightEntry = { value: string; weight: number }

function pickLabel(key: LC.PickKey) {
	switch (key) {
		case 'AllianceMatchup':
			return 'Alliance matchup'
		case 'FactionMatchup':
			return 'Faction matchup'
		case 'UnitMatchup':
			return 'Unit matchup'
		case 'FactionUnitMatchup':
			return 'Faction + unit matchup'
		default:
			return key
	}
}

function formatSide(key: LC.MatchupKey, side: LC.MatchupSide) {
	return LC.matchupSideValues(key, side).join(' ')
}

// Editor for globalSettings.layerGeneration. Generation walks `pickOrder` in order, picking one group per step
// weighted-randomly and discarding the candidates that don't match, so the earlier a step is, the more it shapes the
// result. A step is either a column (its groups are that column's values) or a matchup (its groups are the unordered
// pairings of the two teams). Groups with no configured weight weigh DEFAULT_GENERATION_WEIGHT.
export default function LayerGenerationConfigEditor(
	{ value, onChange, reset$ }: { value: Config; onChange: (next: Config) => void; reset$: Rx.Subject<void> },
) {
	const pickOrder = value.pickOrder ?? []

	function setWeights(column: LC.WeightColumn, entries: WeightEntry[] | undefined) {
		const weights = { ...value.weights }
		if (entries?.length) weights[column] = entries
		else delete weights[column]
		onChange({ ...value, weights })
	}

	function setMatchupWeights(key: LC.MatchupKey, entries: LC.MatchupWeightEntry[]) {
		onChange({ ...value, matchupWeights: { ...value.matchupWeights, [key]: entries } })
	}

	// weights survive their step being dropped from the pick order (so reordering experiments aren't destructive), but
	// they do nothing until it's picked again -- call that out rather than leaving dead config invisible
	const unpicked = LC.PICK_KEYS.options.filter((key) => !pickOrder.includes(key) && weightCount(value, key) > 0)

	return (
		<div className="space-y-5">
			<PickOrderSection value={value} onChange={onChange} />
			{pickOrder.length === 0
				? <p className="text-xs text-muted-foreground">Add a column or matchup above to give its values weights.</p>
				: pickOrder.map((key, idx) => (
					LC.isMatchupKey(key)
						? (
							<MatchupWeightsSection
								key={key}
								matchup={key}
								pickOrder={idx + 1}
								entries={value.matchupWeights[key]}
								onChange={(entries) => setMatchupWeights(key, entries)}
								reset$={reset$}
							/>
						)
						: (
							<WeightsSection
								key={key}
								column={key}
								pickOrder={idx + 1}
								entries={value.weights?.[key] ?? []}
								onChange={(entries) => setWeights(key, entries)}
								reset$={reset$}
							/>
						)
				))}
			{unpicked.length > 0 && (
				<div className="space-y-1.5">
					<SectionLabel hint="These have weights but aren't in the pick order, so they have no effect. Add them above to use them.">
						Unused weights
					</SectionLabel>
					{unpicked.map((key) => (
						<div key={key} className="flex items-center gap-2 text-sm">
							<span className="font-mono">{pickLabel(key)}</span>
							<span className="text-xs text-muted-foreground">{weightCount(value, key)} weighted</span>
							<Button
								type="button"
								size="sm"
								variant="ghost"
								className="h-6 text-destructive"
								onClick={() => LC.isMatchupKey(key) ? setMatchupWeights(key, []) : setWeights(key, undefined)}
							>
								Discard
							</Button>
						</div>
					))}
				</div>
			)}
		</div>
	)
}

function weightCount(value: Config, key: LC.PickKey) {
	return (LC.isMatchupKey(key) ? value.matchupWeights[key]?.length : value.weights?.[key]?.length) ?? 0
}

function SectionLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
	return (
		<div className="space-y-0.5">
			<Label className="text-sm font-semibold">{children}</Label>
			{hint && <p className="text-xs text-muted-foreground">{hint}</p>}
		</div>
	)
}

function PickOrderSection({ value, onChange }: { value: Config; onChange: (next: Config) => void }) {
	const pickOrder = value.pickOrder ?? []
	const addOptions = LC.PICK_KEYS.options
		.filter((key) => !pickOrder.includes(key))
		.map((key) => ({ value: key, label: pickLabel(key) }))

	// drag-to-reorder via the shared dnd-kit provider. the handler is registered once and reads the latest
	// state off a ref, mirroring the layer-table config editor
	const stateRef = React.useRef({ value, onChange })
	stateRef.current = { value, onChange }
	DndKit.useDragEnd(React.useCallback((evt) => {
		const { active, over } = evt
		if (active.type !== 'layer-generation-column' || !over) return
		const slot = over.slots.find((s) => s.dragItem.type === 'layer-generation-column')
		if (!slot) return
		const targetName = String(slot.dragItem.id)
		if (targetName === active.id) return
		const { value, onChange } = stateRef.current
		const order = value.pickOrder ?? []
		const moved = order.find((c) => c === active.id)
		if (!moved) return
		const without = order.filter((c) => c !== active.id)
		let insertAt = without.findIndex((c) => c === targetName)
		if (insertAt < 0) return
		if (slot.position === 'after') insertAt += 1
		onChange({ ...value, pickOrder: [...without.slice(0, insertAt), moved, ...without.slice(insertAt)] })
	}, []))

	// the step's weights are kept (see the "Unused weights" section) so dropping it isn't destructive
	function remove(key: LC.PickKey) {
		onChange({ ...value, pickOrder: pickOrder.filter((k) => k !== key) })
	}

	return (
		<div className="space-y-1.5">
			<SectionLabel hint="Columns and matchups picked weighted-randomly during generation, in pick order. Each pick narrows the candidates for the ones below it, so the first pick shapes the result the most.">
				Pick order
			</SectionLabel>
			{pickOrder.length === 0 && <p className="text-xs text-muted-foreground">Nothing configured: generation picks layers uniformly.</p>}
			<ol>
				{pickOrder.map((key, idx) => (
					<React.Fragment key={key}>
						<PickDropSeparator position="before" pickKey={key} />
						<PickRow pickKey={key} index={idx} weightCount={weightCount(value, key)} onRemove={() => remove(key)} />
					</React.Fragment>
				))}
				{pickOrder.length > 0 && <PickDropSeparator position="after" pickKey={pickOrder[pickOrder.length - 1]} />}
			</ol>
			<ComboBox
				title="Add pick"
				value={undefined}
				options={addOptions}
				onSelect={(key) => {
					if (key && !pickOrder.includes(key)) onChange({ ...value, pickOrder: [...pickOrder, key] })
				}}
			/>
		</div>
	)
}

function PickDropSeparator({ position, pickKey }: { position: 'before' | 'after'; pickKey: string }) {
	const drop = DndKit.useDroppable({
		type: 'relative-to-drag-item',
		slots: [{ position, dragItem: { type: 'layer-generation-column', id: pickKey } }],
	})
	return <li ref={drop.ref} data-over={drop.isDropTarget} className="my-0.5 h-1 rounded bg-primary data-[over=false]:invisible" />
}

function PickRow(
	{ pickKey, index, weightCount, onRemove }: { pickKey: LC.PickKey; index: number; weightCount: number; onRemove: () => void },
) {
	const drag = DndKit.useDraggable({ type: 'layer-generation-column', id: pickKey }, { feedback: 'default' })
	return (
		<li
			ref={drag.ref}
			data-dragging={drag.isDragging}
			className="grid grid-cols-[auto_auto_minmax(0,1fr)_auto_auto] items-center gap-1 rounded-md bg-background data-[dragging=true]:opacity-40"
		>
			<button type="button" ref={drag.handleRef} className="cursor-grab rounded text-muted-foreground" aria-label="Drag to reorder">
				<Icons.GripVertical className="h-4 w-4" />
			</button>
			<span className="w-6 text-right text-xs tabular-nums text-muted-foreground">{index + 1}.</span>
			<span className="min-w-0 truncate font-mono text-sm">{pickLabel(pickKey)}</span>
			<span className="text-xs text-muted-foreground">
				{weightCount === 0 ? 'no weights' : `${weightCount} weighted`}
			</span>
			<Button type="button" size="icon" variant="ghost" className="h-6 w-6 text-destructive" onClick={onRemove}>
				<Icons.X className="h-4 w-4" />
			</Button>
		</li>
	)
}

function WeightsSection(
	{ column, pickOrder, entries, onChange, reset$ }: {
		column: LC.WeightColumn
		pickOrder: number
		entries: WeightEntry[]
		onChange: (entries: WeightEntry[] | undefined) => void
		reset$: Rx.Subject<void>
	},
) {
	const possibleValues = React.useMemo(() => LC.groupByColumnDefaultValues(column) as string[], [column])
	const addOptions = React.useMemo(
		() => possibleValues.filter((v) => !entries.some((e) => e.value === v)).map((v) => ({ value: v, label: v })),
		[possibleValues, entries],
	)

	// weights are relative, so what an admin actually wants to see is the share a value would get. the true
	// denominator depends on which values survive the filters at pick time, so this assumes every value is available:
	// the weights of the real values listed here, plus the default weight for each value that isn't listed. entries
	// for unknown values are excluded -- nothing in the pool can match them
	const knownEntries = entries.filter((e) => possibleValues.includes(e.value))
	const totalWeight = knownEntries.reduce((sum, e) => sum + e.weight, 0)
		+ LC.DEFAULT_GENERATION_WEIGHT * (possibleValues.length - knownEntries.length)

	function setWeight(value: string, weight: number) {
		onChange(entries.map((e) => (e.value === value ? { ...e, weight } : e)))
	}
	function remove(value: string) {
		const next = entries.filter((e) => e.value !== value)
		onChange(next.length ? next : undefined)
	}

	return (
		<div className="space-y-1.5">
			<SectionLabel
				hint={`Pick ${pickOrder}. Unlisted ${column} values weigh ${LC.DEFAULT_GENERATION_WEIGHT}. Shares assume every value is available in the pool.`}
			>
				{column} weights
			</SectionLabel>
			{entries.length > 0 && (
				<table className="w-full max-w-[32rem] text-sm">
					<thead>
						<tr className="text-xs text-muted-foreground">
							<th scope="col" className="text-left font-normal">Value</th>
							<th scope="col" className="text-left font-normal">Weight</th>
							<th scope="col" className="text-right font-normal">Share</th>
							<th scope="col" className="sr-only">Remove</th>
						</tr>
					</thead>
					<tbody>
						{entries.map((entry) => (
							<tr key={entry.value}>
								<td className="py-0.5 pr-2 font-mono">
									{entry.value}
									{/* a value the current layer set doesn't have (e.g. a map dropped by a game update): it can never be picked */}
									{!possibleValues.includes(entry.value) && (
										<span className="ml-1.5 text-xs font-sans text-muted-foreground" title={`No layers have this ${column} value`}>
											(unknown)
										</span>
									)}
								</td>
								<td className="py-0.5 pr-2">
									<WeightInput weight={entry.weight} onChange={(weight) => setWeight(entry.value, weight)} reset$={reset$} />
								</td>
								<td className="py-0.5 pr-2 text-right tabular-nums text-muted-foreground">
									{totalWeight > 0 && possibleValues.includes(entry.value) ? `${(entry.weight / totalWeight * 100).toFixed(1)}%` : '-'}
								</td>
								<td className="py-0.5">
									<Button
										type="button"
										size="icon"
										variant="ghost"
										className="h-6 w-6 text-destructive"
										aria-label={`Remove ${entry.value}`}
										onClick={() => remove(entry.value)}
									>
										<Icons.X className="h-4 w-4" />
									</Button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			<ComboBox
				title={`Add ${column} value`}
				value={undefined}
				options={addOptions}
				onSelect={(value) => {
					if (value && !entries.some((e) => e.value === value)) {
						onChange([...entries, { value, weight: LC.DEFAULT_GENERATION_WEIGHT }])
					}
				}}
			/>
		</div>
	)
}

// A matchup weighs the two teams as an unordered pair, so ADF vs PLA can be weighted apart from ADF and PLA on their
// own. No share column here: unlike a column's values, most pairings of two sides never occur in the layer set (and
// which do depends on the layer), so a share computed over every pairing would be fiction.
function MatchupWeightsSection(
	{ matchup, pickOrder, entries, onChange, reset$ }: {
		matchup: LC.MatchupKey
		pickOrder: number
		entries: LC.MatchupWeightEntry[]
		onChange: (entries: LC.MatchupWeightEntry[]) => void
		reset$: Rx.Subject<void>
	},
) {
	const label = pickLabel(matchup).toLowerCase()

	function setWeight(entryKey: string, weight: number) {
		onChange(entries.map((e) => LC.matchupEntryKey(matchup, e.teams) === entryKey ? { ...e, weight } as LC.MatchupWeightEntry : e))
	}
	function remove(entryKey: string) {
		onChange(entries.filter((e) => LC.matchupEntryKey(matchup, e.teams) !== entryKey))
	}
	function add(teams: [LC.MatchupSide, LC.MatchupSide]) {
		const entryKey = LC.matchupEntryKey(matchup, teams)
		if (entries.some((e) => LC.matchupEntryKey(matchup, e.teams) === entryKey)) return
		onChange([...entries, { teams, weight: LC.DEFAULT_GENERATION_WEIGHT } as LC.MatchupWeightEntry])
	}

	return (
		<div className="space-y-1.5">
			<SectionLabel
				hint={`Pick ${pickOrder}. Unlisted pairings weigh ${LC.DEFAULT_GENERATION_WEIGHT}. Pairings are unordered: the weight applies whichever team fields which side.`}
			>
				{pickLabel(matchup)} weights
			</SectionLabel>
			{entries.length > 0 && (
				<table className="w-full max-w-[32rem] text-sm">
					<thead>
						<tr className="text-xs text-muted-foreground">
							<th scope="col" className="text-left font-normal">Matchup</th>
							<th scope="col" className="text-left font-normal">Weight</th>
							<th scope="col" className="sr-only">Remove</th>
						</tr>
					</thead>
					<tbody>
						{entries.map((entry) => {
							const entryKey = LC.matchupEntryKey(matchup, entry.teams)
							const text = `${formatSide(matchup, entry.teams[0])} vs ${formatSide(matchup, entry.teams[1])}`
							const unknown = entry.teams.some((side) => !LC.isMatchupSideKnown(matchup, side))
							return (
								<tr key={entryKey}>
									<td className="py-0.5 pr-2 font-mono">
										{text}
										{/* a pairing the layer set doesn't have (e.g. a faction dropped by a game update): it can never be picked */}
										{unknown && (
											<span className="ml-1.5 text-xs font-sans text-muted-foreground" title={`No layers have this ${label}`}>
												(unknown)
											</span>
										)}
									</td>
									<td className="py-0.5 pr-2">
										<WeightInput weight={entry.weight} onChange={(weight) => setWeight(entryKey, weight)} reset$={reset$} />
									</td>
									<td className="py-0.5">
										<Button
											type="button"
											size="icon"
											variant="ghost"
											className="h-6 w-6 text-destructive"
											aria-label={`Remove ${text}`}
											onClick={() => remove(entryKey)}
										>
											<Icons.X className="h-4 w-4" />
										</Button>
									</td>
								</tr>
							)
						})}
					</tbody>
				</table>
			)}
			<AddMatchupRow matchup={matchup} onAdd={add} />
		</div>
	)
}

// the two sides of a new matchup. a side is one value for most matchups, and a faction plus one of that faction's
// units for FactionUnitMatchup, which isn't a side until both are chosen
function isSideComplete(matchup: LC.MatchupKey, side: LC.MatchupSide | undefined): side is LC.MatchupSide {
	if (side === undefined) return false
	return LC.matchupSideValues(matchup, side).every((value) => value !== '')
}

function AddMatchupRow({ matchup, onAdd }: { matchup: LC.MatchupKey; onAdd: (teams: [LC.MatchupSide, LC.MatchupSide]) => void }) {
	const [sides, setSides] = React.useState<[LC.MatchupSide | undefined, LC.MatchupSide | undefined]>([undefined, undefined])
	const setSide = (team: 0 | 1, side: LC.MatchupSide | undefined) => setSides((prev) => team === 0 ? [side, prev[1]] : [prev[0], side])
	const complete = isSideComplete(matchup, sides[0]) && isSideComplete(matchup, sides[1])

	return (
		<div className="flex flex-wrap items-center gap-2">
			<MatchupSideInput matchup={matchup} team={1} side={sides[0]} onChange={(side) => setSide(0, side)} />
			<span className="text-xs text-muted-foreground">vs</span>
			<MatchupSideInput matchup={matchup} team={2} side={sides[1]} onChange={(side) => setSide(1, side)} />
			<Button
				type="button"
				size="sm"
				variant="secondary"
				className="h-8"
				disabled={!complete}
				onClick={() => {
					if (!isSideComplete(matchup, sides[0]) || !isSideComplete(matchup, sides[1])) return
					onAdd([sides[0], sides[1]])
					setSides([undefined, undefined])
				}}
			>
				Add matchup
			</Button>
		</div>
	)
}

function MatchupSideInput(
	{ matchup, team, side, onChange }: {
		matchup: LC.MatchupKey
		team: 1 | 2
		side: LC.MatchupSide | undefined
		onChange: (side: LC.MatchupSide | undefined) => void
	},
) {
	if (matchup === 'FactionUnitMatchup') {
		const faction = (side as LC.FactionUnit | undefined)?.Faction
		const unit = (side as LC.FactionUnit | undefined)?.Unit
		const unitOptions = (faction ? L.StaticLayerComponents.factionToUnit[faction] ?? [] : []).map((u) => ({ value: u, label: u }))
		return (
			<div className="flex items-center gap-1">
				<ComboBox
					title={`Faction (team ${team})`}
					value={faction}
					options={LC.groupByColumnDefaultValues('Faction_1').map((f) => ({ value: f, label: f }))}
					onSelect={(next) => onChange(next ? { Faction: next, Unit: '' } : undefined)}
				/>
				<ComboBox
					title={`Unit (team ${team})`}
					value={unit || undefined}
					options={unitOptions}
					disabled={!faction}
					onSelect={(next) => faction && next && onChange({ Faction: faction, Unit: next })}
				/>
			</div>
		)
	}
	const column = LC.MATCHUP_COLUMNS[matchup][0][0]
	return (
		<ComboBox
			title={`${pickLabel(matchup).replace(' matchup', '')} (team ${team})`}
			value={side as string | undefined}
			options={(LC.groupByColumnDefaultValues(column) as string[]).map((v) => ({ value: v, label: v }))}
			onSelect={(next) => onChange(next ?? undefined)}
		/>
	)
}

// uncontrolled + debounced: weights get typed digit by digit, and a controlled input would round-trip every keystroke
// through the settings document. re-mounts on reset$ so it re-reads the value after a programmatic change
function WeightInput({ weight, onChange, reset$ }: { weight: number; onChange: (weight: number) => void; reset$: Rx.Subject<void> }) {
	const [resetKey, setResetKey] = React.useState(0)
	React.useEffect(() => {
		const sub = reset$.subscribe(() => setResetKey((k) => k + 1))
		return () => sub.unsubscribe()
	}, [reset$])
	const push = useDebounced<string>({
		delay: 250,
		onChange: (raw) => {
			const parsed = Number(raw)
			if (raw.trim() === '' || Number.isNaN(parsed) || parsed < 0) return
			onChange(parsed)
		},
	})
	return (
		<input
			key={resetKey}
			type="number"
			min={0}
			step={0.01}
			className="h-8 w-[6rem] rounded-md border bg-background px-2 text-sm"
			defaultValue={weight}
			onChange={(e) => push(e.currentTarget.value)}
		/>
	)
}
