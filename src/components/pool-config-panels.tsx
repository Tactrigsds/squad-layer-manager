import * as Icons from 'lucide-react'
import React from 'react'

import { PermissionDeniedTooltip } from '@/components/permission-denied-tooltip'
import { Button, buttonVariants } from '@/components/ui/button'
import { useDebounced } from '@/hooks/use-debounce.ts'
import * as Arr from '@/lib/array-utils.ts'
import { assertNever } from '@/lib/type-guards.ts'
import * as Typo from '@/lib/typography'
import { cn } from '@/lib/utils.ts'
import * as SETTINGS_Msgs from '@/messages/settings.messages'
import type * as F from '@/models/filter.models.ts'
import * as L from '@/models/layer'
import type * as LC from '@/models/layer-columns.ts'
import * as LQY from '@/models/layer-queries.models.ts'
import type * as LTag from '@/models/layer-tags.models.ts'
import type * as Msgs from '@/models/messages.models.ts'
import * as SETTINGS from '@/models/settings.models.ts'
import * as DndKit from '@/systems/dndkit.client'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import { tr } from '@/systems/messages.client'

import ComboBoxMulti from './combo-box/combo-box-multi.tsx'
import ComboBox from './combo-box/combo-box.tsx'
import { ConstraintViolationIcon } from './constraint-matches-indicator.tsx'
import EmojiDisplay from './emoji-display.tsx'
import { enumGroupings, enumOptionGroups } from './enum-options.helpers.ts'
import FilterEntitySelect, { FilterEntityLink } from './filter-entity-select.tsx'
import { LayerTags } from './layer-tags.tsx'
import { type PoolConfigApi, usePoolValue } from './pool-config-panels.helpers.ts'
import { Alert, AlertDescription } from './ui/alert.tsx'
import { Checkbox } from './ui/checkbox.tsx'
import { Input } from './ui/input.tsx'
import { Label } from './ui/label.tsx'
import { Toggle } from './ui/toggle.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip.tsx'
import { TriStateCheckbox } from './ui/tri-state-checkbox.tsx'

// Shared pool-configuration UI (pool filter, secondary filter lists, repeat rules), used by both the dashboard's
// server-settings popover and the settings page's server forms. All data access goes through PoolConfigApi so the
// two hosts can plug in their own editing substrate (ops-based store vs draft observable).

// compact two-state control shared by every regular/inverted choice in this panel: an icon toggle that lights up
// when inverted, with the meaning carried by the tooltip (and the row's match/miss emoji)
function InvertToggle(props: {
	pressed: boolean
	onPressedChange: (pressed: boolean) => void
	labels: { regular: string; inverted: string }
	disabled?: boolean
}) {
	const label = props.pressed ? props.labels.inverted : props.labels.regular
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				{/* styled via aria-pressed: the wrapping TooltipTrigger overwrites the toggle's data-state with its own */}
				<Toggle
					variant="outline"
					className="h-7 w-7 min-w-7 p-0 aria-pressed:bg-destructive aria-pressed:text-destructive-foreground"
					pressed={props.pressed}
					onPressedChange={props.onPressedChange}
					disabled={props.disabled}
					aria-label={label}
				>
					<Icons.EqualNot className="h-4 w-4" />
				</Toggle>
			</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	)
}

// `trigger` text renders inside the trigger button, so the tooltip opens from the whole label rather than just the ? icon
function HelpTooltip({ label, trigger, children }: { label: string; trigger?: React.ReactNode; children: React.ReactNode }) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					className="flex items-center gap-1 font-medium text-sm text-muted-foreground hover:text-foreground"
					aria-label={label}
				>
					{trigger}
					<Icons.CircleHelp className="h-3.5 w-3.5" />
				</button>
			</TooltipTrigger>
			<TooltipContent className="max-w-xs space-y-2">{children}</TooltipContent>
		</Tooltip>
	)
}

function getMissingIndicatorFields(entity: F.FilterEntity, kind: 'match' | 'miss'): SETTINGS_Msgs.IndicatorField[] {
	const missing: SETTINGS_Msgs.IndicatorField[] = []
	if (kind === 'match') {
		if (!entity.emoji) missing.push('match-emoji')
		if (!entity.alertMessage) missing.push('match-alert')
	} else {
		if (!entity.invertedEmoji) missing.push('miss-emoji')
		if (!entity.invertedAlertMessage) missing.push('miss-alert')
	}
	return missing
}

// warns that a filter used as an indicator is missing the entity fields the indicator renders from; links to the
// filter editor to fix them (a plain anchor -- this renders inside draggable windows, outside the RouterProvider)
function MissingIndicatorWarning({ entity, kind }: { entity: F.FilterEntity; kind: 'match' | 'miss' }) {
	const missing = getMissingIndicatorFields(entity, kind)
	if (missing.length === 0) return null
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<a
					href={`/filters/${entity.id}`}
					target="_blank"
					rel="noreferrer"
					className={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'h-7 w-7 text-destructive hover:text-destructive')}
				>
					<Icons.AlertTriangle className="h-4 w-4" />
				</a>
			</TooltipTrigger>
			<TooltipContent>{tr.text(SETTINGS_Msgs.missingIndicator(kind, missing))}</TooltipContent>
		</Tooltip>
	)
}

// The single pool filter: defines pool membership everywhere (row disabling, force-write gating, warnings,
// autogeneration). The filter entity's emoji/alertMessage pair indicates matches; invertedEmoji/invertedAlertMessage
// indicates misses -- the pool filter needs all four configured.
export function PoolFilterSection({ api }: { api: PoolConfigApi }) {
	const poolFilter = (usePoolValue(api, ['poolFilter']) as SETTINGS.PoolFilterSetting | null) ?? null
	const filterEntities = FilterEntityClient.useFilterEntities()
	const entity = poolFilter ? filterEntities.get(poolFilter.filterId) : undefined

	const onSelect = (filterId: string | null) => {
		api.set(['poolFilter'], filterId === null ? null : { filterId, mode: poolFilter?.mode ?? 'include' })
	}
	const setMode = (mode?: SETTINGS.PoolFilterMode) => {
		if (poolFilter && mode) api.set(['poolFilter', 'mode'], mode)
	}

	const missingIndicators = entity ? [...getMissingIndicatorFields(entity, 'match'), ...getMissingIndicatorFields(entity, 'miss')] : []

	return (
		<div data-tour="pool-filter" className="space-y-3">
			<span className="flex items-center gap-1">
				<h4 className={cn(Typo.H4, 'text-sm font-medium text-muted-foreground')}>{tr.text(SETTINGS_Msgs.poolFilter())}</h4>
				<HelpTooltip label={tr.text(SETTINGS_Msgs.aboutPoolFilter())}>
					<p>{tr.text(SETTINGS_Msgs.poolFilterHelpMembership())}</p>
					<p>{tr.text(SETTINGS_Msgs.poolFilterHelpToggle())}</p>
					<p>{tr.text(SETTINGS_Msgs.poolFilterHelpIndicators())}</p>
				</HelpTooltip>
			</span>
			<div className="border rounded-md p-3 space-y-2">
				<p className="text-xs text-muted-foreground">{tr.text(SETTINGS_Msgs.poolFilterBlurb())}</p>
				<div className="flex items-center gap-2">
					<InvertToggle
						pressed={poolFilter?.mode === 'exclude'}
						onPressedChange={(pressed) => setMode(pressed ? 'exclude' : 'include')}
						labels={SETTINGS_Msgs.poolFilterInvertLabels}
						disabled={!poolFilter || !!api.writeDenied}
					/>
					<FilterEntitySelect
						className="grow"
						title={tr.text(SETTINGS_Msgs.poolFilter())}
						filterId={poolFilter?.filterId ?? null}
						onSelect={onSelect}
						enabled={!api.writeDenied}
					/>
				</div>
				{!poolFilter && <p className="text-sm text-muted-foreground">{tr.text(SETTINGS_Msgs.noPoolFilter())}</p>}
				{entity && missingIndicators.length > 0 && (
					<Alert variant="destructive">
						<AlertDescription className="flex items-center gap-1">
							<span>{tr.text(SETTINGS_Msgs.poolFilterMissingIndicators(missingIndicators))}</span>
							<FilterEntityLink filterId={entity.id} />
						</AlertDescription>
					</Alert>
				)}
			</div>
		</div>
	)
}

type SecondaryListConfig = {
	// 'ids' lists hold bare filter ids; 'applied' lists hold { filterId, applyAs: regular|inverted };
	// 'selectable' additionally admits applyAs: 'disabled' (offered but not applied by default)
	mode: 'ids' | 'applied' | 'selectable'
	emojiFor: 'match' | 'miss' | 'applyAs'
}

const SECONDARY_LISTS: Record<SETTINGS.SecondaryListKey, SecondaryListConfig> = {
	indicateMatches: { mode: 'ids', emojiFor: 'match' },
	indicateMisses: { mode: 'ids', emojiFor: 'miss' },
	defaultSelectable: { mode: 'selectable', emojiFor: 'applyAs' },
	warnFor: { mode: 'applied', emojiFor: 'applyAs' },
	constrainGeneration: { mode: 'applied', emojiFor: 'applyAs' },
}

function SecondaryFilterList({ api, listKey }: { api: PoolConfigApi; listKey: SETTINGS.SecondaryListKey }) {
	const config = SECONDARY_LISTS[listKey]
	const title = tr.text(SETTINGS_Msgs.secondaryListTitles[listKey])
	const path = [listKey]
	const rawValue = (usePoolValue(api, path) as (string | SETTINGS.AppliedFilterSetting | SETTINGS.SelectableFilterSetting)[] | null) ?? []
	const entries = rawValue.map((v) => (typeof v === 'string' ? { filterId: v, applyAs: undefined } : v))
	const filterEntities = FilterEntityClient.useFilterEntities()
	const memberIds = entries.map((e) => e.filterId)

	const add = (filterId: string | null) => {
		if (filterId === null) return
		const added = config.mode === 'ids' ? filterId : { filterId, applyAs: 'regular' }
		api.set(path, [...rawValue, added])
	}
	const remove = (filterId: string) => {
		const current = (api.getValue(path) as (string | SETTINGS.AppliedFilterSetting | SETTINGS.SelectableFilterSetting)[] | null) ?? []
		api.set(
			path,
			current.filter((v) => (typeof v === 'string' ? v : v.filterId) !== filterId),
		)
	}
	const setApplyAs = (index: number, applyAs?: SETTINGS.SelectableFilterApplyAs) => {
		if (!applyAs) return
		api.set([...path, index, 'applyAs'], applyAs)
	}
	const setFilterId = (index: number, filterId: string | null) => {
		if (filterId === null) return
		const current = [
			...((api.getValue(path) as (string | SETTINGS.AppliedFilterSetting | SETTINGS.SelectableFilterSetting)[] | null) ?? []),
		]
		const prev = current[index]
		current[index] = typeof prev === 'string' ? filterId : { ...prev, filterId }
		api.set(path, current)
	}

	return (
		<div data-tour={`pool-list-${listKey}`} className="space-y-2">
			<div className="flex items-center justify-between">
				<h4
					className={cn(Typo.H4, 'text-sm font-medium text-muted-foreground')}
					title={tr.text(SETTINGS_Msgs.secondaryListBlurbs[listKey])}
				>
					{title}
				</h4>
				<PermissionDeniedTooltip denied={api.writeDenied}>
					<FilterEntitySelect
						title={title}
						filterId={null}
						onSelect={add}
						excludedFilterIds={memberIds}
						allowEmpty={false}
						enabled={!api.writeDenied}
					>
						<Button disabled={!!api.writeDenied} size="sm" variant="outline">
							<Icons.Plus className="h-4 w-4" />
						</Button>
					</FilterEntitySelect>
				</PermissionDeniedTooltip>
			</div>
			<div className="border rounded-md p-2 space-y-1">
				<p className="text-xs text-muted-foreground">{tr.text(SETTINGS_Msgs.secondaryListBlurbs[listKey])}</p>
				{entries.map((entry, index) => {
					const entity = filterEntities.get(entry.filterId)
					if (!entity) return null
					const showMiss = config.emojiFor === 'miss' || (config.emojiFor === 'applyAs' && entry.applyAs === 'inverted')
					const emoji = showMiss ? entity.invertedEmoji : entity.emoji
					return (
						<div key={entry.filterId} className="flex items-center gap-2">
							{config.mode === 'applied' && (
								<InvertToggle
									pressed={entry.applyAs === 'inverted'}
									onPressedChange={(pressed) => setApplyAs(index, pressed ? 'inverted' : 'regular')}
									labels={SETTINGS_Msgs.secondaryListInvertLabels[listKey]!}
									disabled={!!api.writeDenied}
								/>
							)}
							{config.mode === 'selectable' && (
								<TriStateCheckbox
									checked={(entry.applyAs as SETTINGS.SelectableFilterApplyAs | undefined) ?? 'disabled'}
									onCheckedChange={(state) => setApplyAs(index, state)}
									disabled={!!api.writeDenied}
									variant="outline"
									size="icon"
									className="h-7 w-7 min-w-7"
									title={tr.text(
										SETTINGS_Msgs.selectableStateTitles[
											(entry.applyAs as SETTINGS.SelectableFilterApplyAs | undefined) ?? 'disabled'
										],
									)}
								/>
							)}
							<FilterEntitySelect
								className="grow min-w-0"
								title={title}
								filterId={entry.filterId}
								onSelect={(filterId) => setFilterId(index, filterId)}
								excludedFilterIds={memberIds.filter((id) => id !== entry.filterId)}
								allowEmpty={false}
								linkClassName="h-7 w-7"
							>
								<Button variant="ghost" disabled={!!api.writeDenied} className="h-7 grow justify-start gap-1 px-1 font-normal">
									{emoji ? <EmojiDisplay size="sm" emoji={emoji} /> : <Icons.Filter className="h-4 w-4 text-orange-400" />}
									<span className="truncate">{entity.name}</span>
									<Icons.ChevronsUpDown className="ml-auto h-3.5 w-3.5 shrink-0 opacity-50" />
								</Button>
							</FilterEntitySelect>
							{config.emojiFor !== 'applyAs' && <MissingIndicatorWarning entity={entity} kind={config.emojiFor} />}
							<Button
								disabled={!!api.writeDenied}
								size="icon"
								variant="outline"
								onClick={() => remove(entry.filterId)}
								className="h-7 w-7"
							>
								<Icons.Minus className="h-4 w-4" />
							</Button>
						</div>
					)
				})}
				{entries.length === 0 && <p className="text-sm text-muted-foreground">{tr.text(SETTINGS_Msgs.noFilters())}</p>}
			</div>
		</div>
	)
}

// Tags whose presence on a queue item silences every warning that item would otherwise raise, for the times a layer is
// queued deliberately in spite of the pool.
function SkipWarningsForTagsSection({ api }: { api: PoolConfigApi }) {
	const path = ['skipWarningsForTags']
	const tags = (usePoolValue(api, path) as LTag.TagId[] | null) ?? []
	return (
		<section aria-label={tr.text(SETTINGS_Msgs.skipWarningsFor())} className="space-y-2">
			<span className="flex items-center gap-1">
				<h4 className={cn(Typo.H4, 'text-sm font-medium text-muted-foreground')}>{tr.text(SETTINGS_Msgs.skipWarningsFor())}</h4>
				<HelpTooltip label={tr.text(SETTINGS_Msgs.aboutSkipWarnings())}>
					<p>{tr.text(SETTINGS_Msgs.skipWarningsHelpSilenced())}</p>
					<p>{tr.text(SETTINGS_Msgs.skipWarningsHelpStillApplies())}</p>
				</HelpTooltip>
			</span>
			<div className="border rounded-md p-2">
				<PermissionDeniedTooltip denied={api.writeDenied}>
					<LayerTags
						tags={tags}
						disabled={!!api.writeDenied}
						onAdd={(tag) => api.set(path, [...((api.getValue(path) as LTag.TagId[] | null) ?? []), tag])}
						onRemove={(tag) =>
							api.set(
								path,
								((api.getValue(path) as LTag.TagId[] | null) ?? []).filter((t) => t !== tag),
							)
						}
					/>
				</PermissionDeniedTooltip>
			</div>
		</section>
	)
}

export function PoolFiltersPanel({ api }: { api: PoolConfigApi }) {
	return (
		<div className="space-y-4">
			<PoolFilterSection api={api} />
			<SkipWarningsForTagsSection api={api} />
			<div className="space-y-3">
				<span className="flex items-center gap-1">
					<h4 className={cn(Typo.H4, 'text-sm font-medium text-muted-foreground')}>{tr.text(SETTINGS_Msgs.secondaryFilters())}</h4>
					<HelpTooltip label={tr.text(SETTINGS_Msgs.aboutSecondaryFilters())}>
						<p>{tr.text(SETTINGS_Msgs.secondaryFiltersHelpBehavior())}</p>
						<p>{tr.text(SETTINGS_Msgs.secondaryFiltersHelpReuse())}</p>
					</HelpTooltip>
				</span>
				<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
					{SETTINGS.SECONDARY_LIST_KEYS.map((listKey) => (
						<SecondaryFilterList key={listKey} api={api} listKey={listKey} />
					))}
				</div>
			</div>
		</div>
	)
}

function BooleanSettingRow({ api, label, description }: { api: PoolConfigApi; label: string; description: string }) {
	const id = React.useId()
	const checked = usePoolValue(api, []) === true
	return (
		<div className="flex items-start gap-2.5">
			<PermissionDeniedTooltip denied={api.writeDenied}>
				<Checkbox
					id={id}
					className="mt-0.5"
					checked={checked}
					disabled={!!api.writeDenied}
					onCheckedChange={(next) => api.set([], next === true)}
				/>
			</PermissionDeniedTooltip>
			<div className="min-w-0 space-y-1">
				<Label htmlFor={id} className="cursor-pointer font-medium">
					{label}
				</Label>
				<p className="text-sm text-muted-foreground">{description}</p>
			</div>
		</div>
	)
}

export function NextLayerPanel({ apis }: { apis: Record<SETTINGS.NextLayerSettingKey, PoolConfigApi> }) {
	return (
		<div className="space-y-3">
			<h4 className={cn(Typo.H4, 'text-sm font-medium text-muted-foreground')}>{tr.text(SETTINGS_Msgs.nextLayer())}</h4>
			<div className="space-y-4">
				{SETTINGS.NEXT_LAYER_SETTING_KEYS.map((key) => (
					<BooleanSettingRow
						key={key}
						api={apis[key]}
						label={tr.text(SETTINGS_Msgs.nextLayerLabels[key])}
						description={SETTINGS.PublicServerSettingsSchema.shape[key].description ?? ''}
					/>
				))}
			</div>
		</div>
	)
}

// The switches a rule carries, keyed by the field each writes. `indicate` and `warn` default on, so they are written
// as explicit booleans; the other two are absent when off, which is what the rest of the app already reads.
const RULE_OPTIONS = ['indicate', 'warn', 'autogen', 'crossTeam'] as const
type RuleOption = (typeof RULE_OPTIONS)[number]

const RULE_OPTION_LABELS: Record<RuleOption, () => Msgs.Variants.Textable> = {
	indicate: SETTINGS_Msgs.repeatRuleIndicate,
	warn: SETTINGS_Msgs.repeatRuleWarn,
	autogen: SETTINGS_Msgs.repeatRuleAutogen,
	crossTeam: SETTINGS_Msgs.repeatRuleCrossTeam,
}

const RULE_OPTION_HELP: Record<RuleOption, () => Msgs.Variants.Textable> = {
	indicate: SETTINGS_Msgs.repeatRuleIndicateHelp,
	warn: SETTINGS_Msgs.repeatRuleWarnHelp,
	autogen: SETTINGS_Msgs.repeatRuleAutogenHelp,
	crossTeam: SETTINGS_Msgs.repeatRuleCrossTeamHelp,
}

// Rules have no identity of their own -- their order is the list -- so panel + index identifies a row. The panel id
// keeps two panels mounted at once (a server form per managed server) from sharing drag ids.
function ruleDragId(panelId: string, idx: number): string {
	return JSON.stringify([panelId, idx])
}

function parseRuleDragId(id: string): { panelId: string; idx: number } {
	const [panelId, idx] = JSON.parse(id) as [string, number]
	return { panelId, idx }
}

// a thin gap between rows that highlights while a rule is dragged over it, and is invisible otherwise
function RuleDropSeparator({ position, panelId, idx }: { position: 'before' | 'after'; panelId: string; idx: number }) {
	const drop = DndKit.useDroppable({
		type: 'relative-to-drag-item',
		slots: [{ position, dragItem: { type: 'repeat-rule', id: ruleDragId(panelId, idx) } }],
	})
	return <li ref={drop.ref} data-over={drop.isDropTarget} className="my-0.5 h-1 rounded bg-primary data-[over=false]:invisible" />
}

const RULE_ROW_GRID = 'grid grid-cols-[auto_minmax(0,2fr)_minmax(0,2fr)_60px_minmax(0,3fr)_minmax(240px,2fr)_auto] items-center gap-2'

function RepeatRuleRow(props: {
	index: number
	panelId: string
	api: PoolConfigApi
	// signals the panel to remount the (uncontrolled) rows so they re-seed after a shift/programmatic label change
	onStructural: () => void
}) {
	const { index, api, onStructural } = props
	const rulesPath = ['repeatRules']
	const rulePath = [...rulesPath, index]

	const rule = usePoolValue(api, rulePath) as SETTINGS.PoolRepeatRuleConfig
	const drag = DndKit.useDraggable({ type: 'repeat-rule', id: ruleDragId(props.panelId, index) }, { feedback: 'default' })

	const setLabel = useDebounced({
		onChange: (label: string) => api.set([...rulePath, 'label'], label),
		delay: 250,
	})

	const setField = (field: LQY.RepeatRuleField) => {
		api.set([...rulePath, 'field'], field)
		api.set([...rulePath, 'label'], field)
		if (!LQY.isTeamSpecificRepeatRuleField(field)) api.set([...rulePath, 'crossTeam'], undefined)
		// values named for the old field match nothing under the new one, which would leave the rule silently inert
		api.set([...rulePath, 'targetValues'], undefined)
		onStructural()
	}

	const setWithin = useDebounced({
		onChange: (within: number) => api.set([...rulePath, 'within'], within),
		delay: 250,
	})

	const setTargetValues = (update: React.SetStateAction<string[]>) => {
		const originalValues = api.getValue([...rulePath, 'targetValues']) as string[] | null
		const targetValues = typeof update === 'function' ? update(originalValues ?? []) : update
		api.set([...rulePath, 'targetValues'], targetValues.length === 0 ? undefined : targetValues)
	}

	const teamSpecific = LQY.isTeamSpecificRepeatRuleField(rule.field)
	const selectedOptions = RULE_OPTIONS.filter((option) => !!rule[option])

	const setOptions = (update: React.SetStateAction<RuleOption[]>) => {
		const next = new Set(typeof update === 'function' ? update(selectedOptions) : update)
		api.set([...rulePath, 'indicate'], next.has('indicate'))
		api.set([...rulePath, 'warn'], next.has('warn'))
		api.set([...rulePath, 'autogen'], next.has('autogen') || undefined)
		api.set([...rulePath, 'crossTeam'], (teamSpecific && next.has('crossTeam')) || undefined)
	}

	const deleteRule = () => {
		const rules = api.getValue(rulesPath) as LQY.RepeatRule[]
		api.set(
			rulesPath,
			rules.filter((_, i) => i !== index),
		)
		onStructural()
	}

	let targetValueOptions: string[]
	// the column the values are drawn from, which is what sorts them into collections. A UnitMatchup value
	// pairs two units, so it belongs to no single column.
	let targetValueColumn: LC.EnumColumn | undefined
	switch (rule.field) {
		case 'Map':
			targetValueOptions = L.StaticLayerComponents.maps
			targetValueColumn = 'Map'
			break
		case 'Layer':
			targetValueOptions = L.StaticLayerComponents.layers
			targetValueColumn = 'Layer'
			break
		case 'Size':
			targetValueOptions = L.StaticLayerComponents.size
			targetValueColumn = 'Size'
			break
		case 'Gamemode':
			targetValueOptions = L.StaticLayerComponents.gamemodes
			targetValueColumn = 'Gamemode'
			break
		case 'Faction':
			targetValueOptions = L.StaticLayerComponents.factions
			targetValueColumn = 'Faction_1'
			break
		case 'Unit':
			targetValueOptions = L.StaticLayerComponents.units
			targetValueColumn = 'Unit_1'
			break
		case 'UnitMatchup':
			targetValueOptions = LQY.unitMatchupOptions(L.StaticLayerComponents.units)
			break
		case 'Alliance':
			targetValueOptions = L.StaticLayerComponents.alliances
			targetValueColumn = 'Alliance_1'
			break
		default:
			assertNever(rule.field)
	}
	const targetOptions = targetValueOptions.map((value) => ({
		value,
		groups: targetValueColumn ? enumOptionGroups(targetValueColumn, value) : undefined,
	}))

	return (
		<li
			ref={drag.ref}
			data-dragging={drag.isDragging}
			className={cn(RULE_ROW_GRID, 'rounded-md bg-background data-[dragging=true]:opacity-40')}
		>
			<button
				type="button"
				ref={drag.handleRef}
				disabled={!!api.writeDenied}
				className="cursor-grab rounded text-muted-foreground disabled:cursor-not-allowed disabled:opacity-40"
				aria-label={tr.text(SETTINGS_Msgs.repeatRuleReorder())}
			>
				<Icons.GripVertical className="h-4 w-4" />
			</button>
			<Input
				placeholder={tr.text(SETTINGS_Msgs.repeatRuleLabel())}
				defaultValue={rule.label ?? rule.field}
				disabled={!!api.writeDenied}
				onChange={(e) => {
					setLabel(e.target.value)
				}}
				className="h-8"
			/>
			<ComboBox
				title={tr.text(SETTINGS_Msgs.repeatRuleFieldPicker())}
				options={LQY.RepeatRuleFieldSchema.options}
				value={rule.field}
				allowEmpty={false}
				onSelect={(value) => {
					if (!value) return
					setField(value as LQY.RepeatRuleField)
				}}
				disabled={!!api.writeDenied}
			/>
			<Input
				type="number"
				defaultValue={rule.within}
				disabled={!!api.writeDenied}
				onChange={(e) => {
					setWithin(Math.floor(Number(e.target.value)))
				}}
				className="h-8"
			/>
			<ComboBoxMulti
				className="w-full min-w-0"
				title={tr.text(SETTINGS_Msgs.repeatRuleTargetPicker())}
				selectOnClose
				options={targetOptions}
				groupings={targetValueColumn ? enumGroupings(targetValueColumn) : undefined}
				disabled={!!api.writeDenied}
				values={rule.targetValues ?? []}
				onSelect={(updated) => {
					setTargetValues(updated)
				}}
			/>
			<ComboBoxMulti
				className="w-full min-w-0 font-sans"
				title={tr.text(SETTINGS_Msgs.repeatRuleOptionsPicker())}
				emptyLabel={tr.text(SETTINGS_Msgs.repeatRuleNoOptions())}
				sort={false}
				options={RULE_OPTIONS.map((option) => ({
					value: option,
					label: tr.text(RULE_OPTION_LABELS[option]()),
					description: tr.text(RULE_OPTION_HELP[option]()),
					// a non-team-specific field has no per-team reading for cross-team to widen
					disabled: option === 'crossTeam' && !teamSpecific,
				}))}
				disabled={!!api.writeDenied}
				values={selectedOptions}
				onSelect={setOptions}
			/>
			<PermissionDeniedTooltip denied={api.writeDenied}>
				<Button size="icon" variant="outline" onClick={deleteRule} disabled={!!api.writeDenied} className="h-8 w-8">
					<Icons.Minus className="h-4 w-4" />
				</Button>
			</PermissionDeniedTooltip>
		</li>
	)
}

export function RepeatRulesPanel(props: { className?: string; api: PoolConfigApi }) {
	const { api } = props
	const panelId = React.useId()
	const rulesPath = ['repeatRules']
	const rulesLength = ((usePoolValue(api, rulesPath) as LQY.RepeatRule[] | null) ?? []).length
	// remounts the uncontrolled rows after edits that shift or rewrite their seeded values
	const [structuralKey, setStructuralKey] = React.useState(0)
	const onStructural = () => setStructuralKey((k) => k + 1)

	const addRule = () => {
		const rules = (api.getValue(rulesPath) as LQY.RepeatRule[] | null) ?? []
		api.set(rulesPath, [...rules, { field: 'Map', within: 0, label: 'Map', indicate: true, warn: true }])
	}

	// drag-to-reorder via the shared dnd-kit provider (see dndkit.client). The handler is registered once and reads
	// the latest api off a ref; another panel's drop is ignored by its panel id.
	const stateRef = React.useRef({ panelId, api, onStructural })
	stateRef.current = { panelId, api, onStructural }
	DndKit.useDragEnd(
		React.useCallback((evt) => {
			const { active, over } = evt
			if (active.type !== 'repeat-rule' || !over) return
			const slot = over.slots.find((s) => s.dragItem.type === 'repeat-rule')
			// the separators only ever register before/after; 'on' would mean dropping onto a rule itself, which reorders nothing
			if (!slot || slot.position === 'on') return
			const from = parseRuleDragId(active.id)
			const to = parseRuleDragId(String(slot.dragItem.id))
			const { panelId, api, onStructural } = stateRef.current
			if (from.panelId !== panelId || to.panelId !== panelId) return
			const rules = (api.getValue(['repeatRules']) as SETTINGS.PoolRepeatRuleConfig[] | null) ?? []
			const reordered = Arr.moveItem(rules, from.idx, to.idx, slot.position)
			if (reordered === rules) return
			api.set(['repeatRules'], reordered)
			onStructural()
		}, []),
	)

	return (
		<div data-tour="pool-repeat-rules" className={cn('space-y-3', props.className)}>
			<div className="flex items-center justify-between">
				<span className="flex items-center gap-2">
					<h4 className={cn(Typo.H4, 'text-sm font-medium text-muted-foreground')}>{tr.text(SETTINGS_Msgs.repeatRules())}</h4>
					<ConstraintViolationIcon />
				</span>
				<PermissionDeniedTooltip denied={api.writeDenied}>
					<Button size="sm" variant="outline" disabled={!!api.writeDenied} onClick={addRule}>
						<Icons.Plus className="h-4 w-4 mr-2" />
						{tr.text(SETTINGS_Msgs.addRepeatRule())}
					</Button>
				</PermissionDeniedTooltip>
			</div>
			<div className="border rounded-md p-3">
				<div className={cn(RULE_ROW_GRID, 'text-sm font-medium text-muted-foreground')}>
					<span />
					<span>{tr.text(SETTINGS_Msgs.repeatRuleLabel())}</span>
					<span>{tr.text(SETTINGS_Msgs.repeatRuleField())}</span>
					<span>{tr.text(SETTINGS_Msgs.repeatRuleWithin())}</span>
					<span data-tour="repeat-rule-targets">{tr.text(SETTINGS_Msgs.repeatRuleTargetValues())}</span>
					<span data-tour="repeat-rule-options">{tr.text(SETTINGS_Msgs.repeatRuleOptions())}</span>
					<span />
				</div>
				{/* Rules; keyed on resetKey/structuralKey too so uncontrolled inputs re-seed after structural changes/resets */}
				<ol>
					{Array.from({ length: rulesLength }, (_, index) => (
						<React.Fragment key={`${api.resetKey}:${structuralKey}:${index}`}>
							<RuleDropSeparator position="before" panelId={panelId} idx={index} />
							<RepeatRuleRow index={index} panelId={panelId} api={api} onStructural={onStructural} />
						</React.Fragment>
					))}
					{rulesLength > 0 && <RuleDropSeparator position="after" panelId={panelId} idx={rulesLength - 1} />}
				</ol>
			</div>
		</div>
	)
}
