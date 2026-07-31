import * as Icons from 'lucide-react'
import React from 'react'

import { PermissionDeniedTooltip } from '@/components/permission-denied-tooltip'
import { Button, buttonVariants } from '@/components/ui/button'
import { useDebounced } from '@/hooks/use-debounce.ts'
import { assertNever } from '@/lib/type-guards.ts'
import * as Typo from '@/lib/typography'
import { cn } from '@/lib/utils.ts'
import * as SETTINGS_Msgs from '@/messages/settings.messages'
import type * as F from '@/models/filter.models.ts'
import * as L from '@/models/layer'
import * as LQY from '@/models/layer-queries.models.ts'
import type * as LTag from '@/models/layer-tags.models.ts'
import * as SETTINGS from '@/models/settings.models.ts'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import { tr } from '@/systems/messages.client'

import ComboBoxMulti from './combo-box/combo-box-multi.tsx'
import ComboBox from './combo-box/combo-box.tsx'
import { ConstraintViolationIcon } from './constraint-matches-indicator.tsx'
import EmojiDisplay from './emoji-display.tsx'
import FilterEntitySelect, { FilterEntityLink } from './filter-entity-select.tsx'
import { LayerTags } from './layer-tags.tsx'
import type { PoolConfigApi } from './pool-config-panels.helpers.ts'
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
	const poolFilter = (api.useValue(['poolFilter']) as SETTINGS.PoolFilterSetting | null) ?? null
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
		<div className="space-y-3">
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
	const rawValue = (api.useValue(path) as (string | SETTINGS.AppliedFilterSetting | SETTINGS.SelectableFilterSetting)[] | null) ?? []
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
		<div className="space-y-2">
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
	const tags = (api.useValue(path) as LTag.TagId[] | null) ?? []
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
	const checked = api.useValue([]) === true
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

function RepeatRuleRow(props: {
	index: number
	api: PoolConfigApi
	// signals the panel to remount the (uncontrolled) rows so they re-seed after a shift/programmatic label change
	onStructural: () => void
}) {
	const { index, api, onStructural } = props
	const rulesPath = ['repeatRules']
	const rulePath = [...rulesPath, index]

	const rule = api.useValue(rulePath) as SETTINGS.PoolRepeatRuleConfig

	const setLabel = useDebounced({
		onChange: (label: string) => api.set([...rulePath, 'label'], label),
		delay: 250,
	})

	const setField = (field: LQY.RepeatRuleField) => {
		api.set([...rulePath, 'field'], field)
		api.set([...rulePath, 'label'], field)
		if (!LQY.isTeamSpecificRepeatRuleField(field)) api.set([...rulePath, 'crossTeam'], undefined)
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

	const setWarn = (warn: boolean) => {
		api.set([...rulePath, 'warn'], warn || undefined)
	}

	const setAutogen = (autogen: boolean) => {
		api.set([...rulePath, 'autogen'], autogen || undefined)
	}

	const setCrossTeam = (crossTeam: boolean) => {
		api.set([...rulePath, 'crossTeam'], crossTeam || undefined)
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
	switch (rule.field) {
		case 'Map':
			targetValueOptions = L.StaticLayerComponents.maps
			break
		case 'Layer':
			targetValueOptions = L.StaticLayerComponents.layers
			break
		case 'Size':
			targetValueOptions = L.StaticLayerComponents.size
			break
		case 'Gamemode':
			targetValueOptions = L.StaticLayerComponents.gamemodes
			break
		case 'Faction':
			targetValueOptions = L.StaticLayerComponents.factions
			break
		case 'Alliance':
			targetValueOptions = L.StaticLayerComponents.alliances
			break
		default:
			assertNever(rule.field)
	}

	return (
		<>
			<div className="contents">
				<Input
					placeholder={tr.text(SETTINGS_Msgs.repeatRuleLabel())}
					defaultValue={rule.label ?? rule.field}
					disabled={!!api.writeDenied}
					onChange={(e) => {
						setLabel(e.target.value)
					}}
					className="h-8"
				/>
			</div>
			<div className="contents">
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
			</div>
			<div className="contents">
				<Input
					type="number"
					defaultValue={rule.within}
					disabled={!!api.writeDenied}
					onChange={(e) => {
						setWithin(Math.floor(Number(e.target.value)))
					}}
					className="h-8"
				/>
			</div>
			<div className="contents">
				<ComboBoxMulti
					className="w-full min-w-0"
					title={tr.text(SETTINGS_Msgs.repeatRuleTargetPicker())}
					selectOnClose
					options={targetValueOptions}
					disabled={!!api.writeDenied}
					values={rule.targetValues ?? []}
					onSelect={(updated) => {
						setTargetValues(updated)
					}}
				/>
			</div>
			<div className="contents">
				<Checkbox
					title={tr.text(SETTINGS_Msgs.repeatRuleCrossTeamTitle())}
					checked={!!rule.crossTeam}
					disabled={!!api.writeDenied || !LQY.isTeamSpecificRepeatRuleField(rule.field)}
					onCheckedChange={(checked) => setCrossTeam(checked === true)}
				/>
			</div>
			<div className="contents">
				<Checkbox
					title={tr.text(SETTINGS_Msgs.repeatRuleWarnTitle())}
					checked={!!rule.warn}
					disabled={!!api.writeDenied}
					onCheckedChange={(checked) => setWarn(checked === true)}
				/>
			</div>
			<div className="contents">
				<Checkbox
					title={tr.text(SETTINGS_Msgs.repeatRuleAutogenTitle())}
					checked={!!rule.autogen}
					disabled={!!api.writeDenied}
					onCheckedChange={(checked) => setAutogen(checked === true)}
				/>
			</div>
			<div className="contents">
				<PermissionDeniedTooltip denied={api.writeDenied}>
					<Button size="icon" variant="outline" onClick={deleteRule} disabled={!!api.writeDenied} className="h-8 w-8">
						<Icons.Minus className="h-4 w-4" />
					</Button>
				</PermissionDeniedTooltip>
			</div>
		</>
	)
}

export function RepeatRulesPanel(props: { className?: string; api: PoolConfigApi }) {
	const { api } = props
	const rulesPath = ['repeatRules']
	const rulesLength = ((api.useValue(rulesPath) as LQY.RepeatRule[] | null) ?? []).length
	// remounts the uncontrolled rows after edits that shift or rewrite their seeded values
	const [structuralKey, setStructuralKey] = React.useState(0)
	const onStructural = () => setStructuralKey((k) => k + 1)

	const addRule = () => {
		const rules = (api.getValue(rulesPath) as LQY.RepeatRule[] | null) ?? []
		api.set(rulesPath, [...rules, { field: 'Map', within: 0, label: 'Map' }])
	}

	return (
		<div className={cn('space-y-3', props.className)}>
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
				<div
					className="grid gap-2 items-center"
					style={{ gridTemplateColumns: '2fr 2fr 60px 4fr max-content max-content max-content max-content' }}
				>
					{/* Header Row */}
					<div className="contents text-sm font-medium text-muted-foreground">
						<div>{tr.text(SETTINGS_Msgs.repeatRuleLabel())}</div>
						<div>{tr.text(SETTINGS_Msgs.repeatRuleField())}</div>
						<div>{tr.text(SETTINGS_Msgs.repeatRuleWithin())}</div>
						<div>{tr.text(SETTINGS_Msgs.repeatRuleTargetValues())}</div>
						<div>
							<HelpTooltip
								label={tr.text(SETTINGS_Msgs.repeatRuleCrossTeamHelpTitle())}
								trigger={tr.text(SETTINGS_Msgs.repeatRuleCrossTeam())}
							>
								<p>{tr.text(SETTINGS_Msgs.repeatRuleCrossTeamHelp())}</p>
							</HelpTooltip>
						</div>
						<div>
							<HelpTooltip label={tr.text(SETTINGS_Msgs.aboutRepeatRuleWarn())} trigger={tr.text(SETTINGS_Msgs.repeatRuleWarn())}>
								<p>{tr.text(SETTINGS_Msgs.repeatRuleWarnHelp())}</p>
							</HelpTooltip>
						</div>
						<div>
							<HelpTooltip
								label={tr.text(SETTINGS_Msgs.aboutRepeatRuleAutogen())}
								trigger={tr.text(SETTINGS_Msgs.repeatRuleAutogen())}
							>
								<p>{tr.text(SETTINGS_Msgs.repeatRuleAutogenHelp())}</p>
							</HelpTooltip>
						</div>
						<div></div>
					</div>
					{/* Rules; keyed on resetKey/structuralKey too so uncontrolled inputs re-seed after structural changes/resets */}
					{Array.from({ length: rulesLength }, (_, index) => (
						<RepeatRuleRow key={`${api.resetKey}:${structuralKey}:${index}`} index={index} api={api} onStructural={onStructural} />
					))}
				</div>
			</div>
		</div>
	)
}
