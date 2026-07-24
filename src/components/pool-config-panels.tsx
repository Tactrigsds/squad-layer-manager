import { PermissionDeniedTooltip } from '@/components/permission-denied-tooltip'
import { Button, buttonVariants } from '@/components/ui/button'
import { useDebounced } from '@/hooks/use-debounce.ts'
import { assertNever } from '@/lib/type-guards.ts'
import * as Typography from '@/lib/typography.ts'
import { cn } from '@/lib/utils.ts'
import type * as F from '@/models/filter.models.ts'
import * as L from '@/models/layer'
import * as LQY from '@/models/layer-queries.models.ts'
import * as SETTINGS from '@/models/settings.models.ts'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import * as Icons from 'lucide-react'
import React from 'react'
import ComboBoxMulti from './combo-box/combo-box-multi.tsx'
import ComboBox from './combo-box/combo-box.tsx'
import { ConstraintViolationIcon } from './constraint-matches-indicator.tsx'
import EmojiDisplay from './emoji-display.tsx'
import FilterEntitySelect, { FilterEntityLink } from './filter-entity-select.tsx'
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

function getMissingIndicatorFields(entity: F.FilterEntity, kind: 'match' | 'miss'): string[] {
	if (kind === 'match') {
		return [!entity.emoji && 'match emoji', !entity.alertMessage && 'match alert message'].filter(v => typeof v === 'string')
	}
	return [!entity.invertedEmoji && 'miss emoji', !entity.invertedAlertMessage && 'miss alert message'].filter(v => typeof v === 'string')
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
			<TooltipContent>
				This filter's {kind} indicator won't display: it has no {missing.join(' or ')} configured. Click to edit the filter.
			</TooltipContent>
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

	const missingIndicators = entity
		? [...getMissingIndicatorFields(entity, 'match'), ...getMissingIndicatorFields(entity, 'miss')]
		: []

	return (
		<div className="space-y-3">
			<span className="flex items-center gap-1">
				<h4 className={cn(Typography.H4, 'text-sm font-medium text-muted-foreground')}>Pool Filter</h4>
				<HelpTooltip label="About the pool filter">
					<p>
						Out-of-pool layers are hidden behind the pool toggle during layer selection, and only users with the queue:force-write
						permission can queue them. Saving one warns the editor, and in-game admins are warned when one is about to be played.
						Autogenerated layers always come from the pool.
					</p>
					<p>
						The toggle in front of the filter flips it between including its matching layers in the pool and excluding them from it.
					</p>
					<p>
						The filter's match indicators (emoji and alert message, plus the inverted pair for misses) are what mark a layer as in or out of
						the pool across the app, so the pool filter needs all of them configured.
					</p>
				</HelpTooltip>
			</span>
			<div className="border rounded-md p-3 space-y-2">
				<p className="text-xs text-muted-foreground">
					The single filter deciding which layers are in the server's layer pool
				</p>
				<div className="flex items-center gap-2">
					<InvertToggle
						pressed={poolFilter?.mode === 'exclude'}
						onPressedChange={(pressed) => setMode(pressed ? 'exclude' : 'include')}
						labels={{ regular: 'Matching layers are in the pool', inverted: 'Matching layers are excluded from the pool' }}
						disabled={!poolFilter || !!api.writeDenied}
					/>
					<FilterEntitySelect
						className="grow"
						title="Pool Filter"
						filterId={poolFilter?.filterId ?? null}
						onSelect={onSelect}
						enabled={!api.writeDenied}
					/>
				</div>
				{!poolFilter && (
					<p className="text-sm text-muted-foreground">
						No pool filter configured: every layer is in the pool.
					</p>
				)}
				{entity && missingIndicators.length > 0 && (
					<Alert variant="destructive">
						<AlertDescription className="flex items-center gap-1">
							<span>
								The pool filter must have match and miss indicators configured. Missing: {missingIndicators.join(', ')}.
							</span>
							<FilterEntityLink filterId={entity.id} />
						</AlertDescription>
					</Alert>
				)}
			</div>
		</div>
	)
}

type SecondaryListKey = 'indicateMatches' | 'indicateMisses' | 'defaultSelectable' | 'warnFor' | 'constrainGeneration'

type SecondaryListConfig = {
	key: SecondaryListKey
	title: string
	description: string
	// 'ids' lists hold bare filter ids; 'applied' lists hold { filterId, applyAs: regular|inverted };
	// 'selectable' additionally admits applyAs: 'disabled' (offered but not applied by default)
	mode: 'ids' | 'applied' | 'selectable'
	emojiFor: 'match' | 'miss' | 'applyAs'
	applyAsLabels?: { regular: string; inverted: string }
}

const SECONDARY_LISTS: SecondaryListConfig[] = [
	{
		key: 'indicateMatches',
		title: 'Indicate matches for',
		description: "Layers matching these filters display the filter's match emoji",
		mode: 'ids',
		emojiFor: 'match',
	},
	{
		key: 'indicateMisses',
		title: 'Indicate misses for',
		description: "Layers NOT matching these filters display the filter's miss emoji",
		mode: 'ids',
		emojiFor: 'miss',
	},
	{
		key: 'defaultSelectable',
		title: 'Default selectable filters',
		description: 'Offered during layer selection; the checkbox is the state they start in',
		mode: 'selectable',
		emojiFor: 'applyAs',
	},
	{
		key: 'warnFor',
		title: 'Warn for',
		description: 'Warn when a layer in the configured state is queued or about to be played',
		mode: 'applied',
		emojiFor: 'applyAs',
		applyAsLabels: { regular: 'Warn on match', inverted: 'Warn on miss' },
	},
	{
		key: 'constrainGeneration',
		title: 'Constrain generated pool for',
		description: 'Autogenerated layers are constrained by these filters, on top of the pool filter',
		mode: 'applied',
		emojiFor: 'applyAs',
		applyAsLabels: { regular: 'Must match', inverted: 'Must not match' },
	},
]

const SELECTABLE_STATE_TITLES: Record<SETTINGS.SelectableFilterApplyAs, string> = {
	disabled: 'Offered but not applied by default (Ctrl+Click to invert)',
	regular: 'Applied by default (Ctrl+Click to invert)',
	inverted: 'Applied inverted by default',
}

function SecondaryFilterList({ api, config }: { api: PoolConfigApi; config: SecondaryListConfig }) {
	const path = [config.key]
	const rawValue = (api.useValue(path) as (string | SETTINGS.AppliedFilterSetting | SETTINGS.SelectableFilterSetting)[] | null) ?? []
	const entries = rawValue.map(v => typeof v === 'string' ? { filterId: v, applyAs: undefined } : v)
	const filterEntities = FilterEntityClient.useFilterEntities()
	const memberIds = entries.map(e => e.filterId)

	const add = (filterId: string | null) => {
		if (filterId === null) return
		const added = config.mode === 'ids' ? filterId : { filterId, applyAs: 'regular' }
		api.set(path, [...rawValue, added])
	}
	const remove = (filterId: string) => {
		const current = (api.getValue(path) as (string | SETTINGS.AppliedFilterSetting | SETTINGS.SelectableFilterSetting)[] | null) ?? []
		api.set(path, current.filter(v => (typeof v === 'string' ? v : v.filterId) !== filterId))
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
				<h4 className={cn(Typography.H4, 'text-sm font-medium text-muted-foreground')} title={config.description}>
					{config.title}
				</h4>
				<PermissionDeniedTooltip denied={api.writeDenied}>
					<FilterEntitySelect
						title={config.title}
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
				<p className="text-xs text-muted-foreground">{config.description}</p>
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
									labels={config.applyAsLabels!}
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
									title={SELECTABLE_STATE_TITLES[(entry.applyAs as SETTINGS.SelectableFilterApplyAs | undefined) ?? 'disabled']}
								/>
							)}
							<FilterEntitySelect
								className="grow min-w-0"
								title={config.title}
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
				{entries.length === 0 && <p className="text-sm text-muted-foreground">No filters</p>}
			</div>
		</div>
	)
}

export function PoolFiltersPanel({ api }: { api: PoolConfigApi }) {
	return (
		<div className="space-y-4">
			<PoolFilterSection api={api} />
			<div className="space-y-3">
				<span className="flex items-center gap-1">
					<h4 className={cn(Typography.H4, 'text-sm font-medium text-muted-foreground')}>Secondary Filters</h4>
					<HelpTooltip label="About secondary filters">
						<p>
							Secondary filters never decide what is in the pool; they add behavior on top of it: displaying match or miss indicators on
							layers, being offered during layer selection, warning when a matching layer is queued or about to be played, and further
							constraining autogeneration.
						</p>
						<p>A filter can appear in several of these lists at once.</p>
					</HelpTooltip>
				</span>
				<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
					{SECONDARY_LISTS.map((config) => <SecondaryFilterList key={config.key} api={api} config={config} />)}
				</div>
			</div>
		</div>
	)
}

// the settings deciding what SLM does about the next layer, each addressed by its own single-key api so its checkbox
// is gated on write access to exactly that setting. Descriptions come from the schema so they can't drift from the
// ones the settings page shows.
export const NEXT_LAYER_SETTING_KEYS = ['overrideAdminSetNextLayer', 'warnOnChangeLayer'] as const
export type NextLayerSettingKey = typeof NEXT_LAYER_SETTING_KEYS[number]

const NEXT_LAYER_LABELS: Record<NextLayerSettingKey, string> = {
	overrideAdminSetNextLayer: 'Override the next layer when it is set outside SLM',
	warnOnChangeLayer: 'Warn admins when SLM changes the next layer',
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
				<Label htmlFor={id} className="cursor-pointer font-medium">{label}</Label>
				<p className="text-sm text-muted-foreground">{description}</p>
			</div>
		</div>
	)
}

export function NextLayerPanel({ apis }: { apis: Record<NextLayerSettingKey, PoolConfigApi> }) {
	return (
		<div className="space-y-3">
			<h4 className={cn(Typography.H4, 'text-sm font-medium text-muted-foreground')}>Next Layer</h4>
			<div className="space-y-4">
				{NEXT_LAYER_SETTING_KEYS.map((key) => (
					<BooleanSettingRow
						key={key}
						api={apis[key]}
						label={NEXT_LAYER_LABELS[key]}
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

	const deleteRule = () => {
		const rules = api.getValue(rulesPath) as LQY.RepeatRule[]
		api.set(rulesPath, rules.filter((_, i) => i !== index))
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
					placeholder="Label"
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
					title="Rule"
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
					title="Target"
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
					title="Warn when a layer violating this rule is queued or about to be played"
					checked={!!rule.warn}
					disabled={!!api.writeDenied}
					onCheckedChange={(checked) => setWarn(checked === true)}
				/>
			</div>
			<div className="contents">
				<Checkbox
					title="Apply this rule when autogenerating layers"
					checked={!!rule.autogen}
					disabled={!!api.writeDenied}
					onCheckedChange={(checked) => setAutogen(checked === true)}
				/>
			</div>
			<div className="contents">
				<PermissionDeniedTooltip denied={api.writeDenied}>
					<Button
						size="icon"
						variant="outline"
						onClick={deleteRule}
						disabled={!!api.writeDenied}
						className="h-8 w-8"
					>
						<Icons.Minus className="h-4 w-4" />
					</Button>
				</PermissionDeniedTooltip>
			</div>
		</>
	)
}

export function RepeatRulesPanel(props: {
	className?: string
	api: PoolConfigApi
}) {
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
					<h4 className={cn(Typography.H4, 'text-sm font-medium text-muted-foreground')}>
						Repeat Rules
					</h4>
					<ConstraintViolationIcon />
				</span>
				<PermissionDeniedTooltip denied={api.writeDenied}>
					<Button
						size="sm"
						variant="outline"
						disabled={!!api.writeDenied}
						onClick={addRule}
					>
						<Icons.Plus className="h-4 w-4 mr-2" />
						Add Repeat Rule
					</Button>
				</PermissionDeniedTooltip>
			</div>
			<div className="border rounded-md p-3">
				<div
					className="grid gap-2 items-center"
					style={{ gridTemplateColumns: '2fr 2fr 60px 4fr max-content max-content max-content' }}
				>
					{/* Header Row */}
					<div className="contents text-sm font-medium text-muted-foreground">
						<div>Label</div>
						<div>Field</div>
						<div>Within</div>
						<div>Target Values</div>
						<div>
							<HelpTooltip label="About repeat rule warnings" trigger="Warn">
								<p>Warn the editor before saving a layer that violates this rule, and in-game admins when one is about to be played</p>
							</HelpTooltip>
						</div>
						<div>
							<HelpTooltip label="About repeat rules during autogeneration" trigger="Autogen">
								<p>Also apply this rule when autogenerating layers</p>
							</HelpTooltip>
						</div>
						<div></div>
					</div>
					{/* Rules; keyed on resetKey/structuralKey too so uncontrolled inputs re-seed after structural changes/resets */}
					{Array.from({ length: rulesLength }, (_, index) => (
						<RepeatRuleRow
							key={`${api.resetKey}:${structuralKey}:${index}`}
							index={index}
							api={api}
							onStructural={onStructural}
						/>
					))}
				</div>
			</div>
		</div>
	)
}
