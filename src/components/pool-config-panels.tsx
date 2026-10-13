import * as Icons from 'lucide-react'
import React from 'react'

import { PermissionDeniedTooltip } from '@/components/permission-denied-tooltip'
import { Button, buttonVariants } from '@/components/ui/button'
import * as RepeatRulesetEditorFrame from '@/frames/repeat-ruleset-editor.frame'
import { useDebounced } from '@/hooks/use-debounce.ts'
import * as Arr from '@/lib/array-utils.ts'
import type * as DH from '@/lib/display-helpers.ts'
import { assertNever } from '@/lib/type-guards.ts'
import * as Typo from '@/lib/typography'
import { cn } from '@/lib/utils.ts'
import * as ZodUtils from '@/lib/zod-utils'
import * as Zus from '@/lib/zustand'
import * as SETTINGS_Msgs from '@/messages/settings.messages'
import * as UI_Msgs from '@/messages/ui.messages'
import type * as F from '@/models/filter.models.ts'
import type * as LC from '@/models/layer-columns.models.ts'
import * as LQY from '@/models/layer-queries.models.ts'
import type * as LTag from '@/models/layer-tags.models.ts'
import * as L from '@/models/layer.models'
import type * as Msgs from '@/models/messages.models.ts'
import * as RRS from '@/models/repeat-rulesets.models'
import * as SETTINGS from '@/models/settings.models.ts'
import * as DndKit from '@/systems/dndkit.client'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import { tr } from '@/systems/messages.client'
import * as RbacClient from '@/systems/rbac.client'
import * as SettingsClient from '@/systems/settings.client'

import ComboBoxMulti from './combo-box/combo-box-multi.tsx'
import ComboBox from './combo-box/combo-box.tsx'
import { ConstraintViolationIcon } from './constraint-matches-indicator.tsx'
import EmojiDisplay from './emoji-display.tsx'
import { enumGroupings, enumOptionGroups } from './enum-options.helpers.ts'
import FilterEntitySelect, { FilterEntityLink } from './filter-entity-select.tsx'
import { LayerTags } from './layer-tags.tsx'
import { type PoolConfigApi, usePoolValue, useRepeatRulesetRulesApi } from './pool-config-panels.helpers.ts'
import { Alert, AlertDescription } from './ui/alert.tsx'
import { Badge } from './ui/badge'
import { Checkbox } from './ui/checkbox.tsx'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import { Input } from './ui/input.tsx'
import { Label } from './ui/label.tsx'
import { Spinner } from './ui/spinner.tsx'
import { Toggle } from './ui/toggle.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip.tsx'
import { TriStateCheckbox } from './ui/tri-state-checkbox.tsx'
import { VoteDisplayPropsCheckboxes } from './vote-display-props-checkboxes.tsx'

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
		<Tooltip help>
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
				<div className="flex flex-wrap items-center gap-2">
					<InvertToggle
						pressed={poolFilter?.mode === 'exclude'}
						onPressedChange={(pressed) => setMode(pressed ? 'exclude' : 'include')}
						labels={SETTINGS_Msgs.poolFilterInvertLabels}
						disabled={!poolFilter || !!api.writeDenied}
					/>
					<FilterEntitySelect
						className="w-[260px] max-w-full"
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
	layerRequestFilters: { mode: 'applied', emojiFor: 'applyAs' },
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
									{emoji ? <EmojiDisplay size="sm" emoji={emoji} /> : <Icons.Filter className="h-4 w-4 text-warn" />}
									<span className="truncate">{entity.name}</span>
									<Icons.ChevronsUpDown className="ms-auto h-3.5 w-3.5 shrink-0 opacity-50" />
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

const ROOT_PATH: SETTINGS.SettingsPath = []

function BooleanSettingRow({
	api,
	path = ROOT_PATH,
	label,
	description,
	tourId,
}: {
	api: PoolConfigApi
	path?: SETTINGS.SettingsPath
	label: string
	description: string
	tourId?: string
}) {
	const id = React.useId()
	const checked = usePoolValue(api, path) === true
	return (
		<div data-tour={tourId} className="flex items-start gap-2.5">
			<PermissionDeniedTooltip denied={api.writeDenied}>
				<Checkbox
					id={id}
					className="mt-0.5"
					checked={checked}
					disabled={!!api.writeDenied}
					onCheckedChange={(next) => api.set(path, next)}
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
		<div data-tour="pool-next-layer" className="space-y-3">
			<h4 className={cn(Typo.H4, 'text-sm font-medium text-muted-foreground')}>{tr.text(SETTINGS_Msgs.nextLayer())}</h4>
			<div className="space-y-4">
				{SETTINGS.NEXT_LAYER_SETTING_KEYS.map((key) => (
					<BooleanSettingRow
						key={key}
						api={apis[key]}
						label={tr.text(SETTINGS_Msgs.nextLayerLabels[key])}
						description={SETTINGS.PublicServerSettingsSchema.shape[key].description ?? ''}
						tourId={`next-layer-${key}`}
					/>
				))}
			</div>
		</div>
	)
}

// the settings page edits the vote settings in its own section, so only the pool configuration window passes autoStartApi
export function GenerationPanel({ api, autoStartApi }: { api: PoolConfigApi; autoStartApi?: PoolConfigApi }) {
	const enabled = usePoolValue(api, ['generateVotes', 'enabled']) === true
	const displayProps = (usePoolValue(api, ['generateVotes', 'displayProps']) as DH.LayerDisplayProp[] | undefined) ?? []
	return (
		<div className="space-y-6">
			<div className="space-y-3">
				<h4 className={cn(Typo.H4, 'text-sm font-medium text-muted-foreground')}>{tr.text(SETTINGS_Msgs.generatedVotes())}</h4>
				<BooleanSettingRow
					api={api}
					path={['generateVotes', 'enabled']}
					label={tr.text(SETTINGS_Msgs.generateVotesLabel())}
					description={tr.text(SETTINGS_Msgs.generateVotesHelp())}
				/>
				<div className="space-y-2 ps-6">
					<div className="space-y-1">
						<h5 className="text-sm font-medium">{tr.text(SETTINGS_Msgs.generatedVoteDisplayOptions())}</h5>
						<p className="text-sm text-muted-foreground">{tr.text(SETTINGS_Msgs.generatedVoteDisplayOptionsHelp())}</p>
					</div>
					<PermissionDeniedTooltip denied={api.writeDenied}>
						<div>
							<VoteDisplayPropsCheckboxes
								displayProps={displayProps}
								onChange={(next) => api.set(['generateVotes', 'displayProps'], next)}
								disabled={!enabled || !!api.writeDenied}
								lockMap
							/>
						</div>
					</PermissionDeniedTooltip>
				</div>
			</div>
			{autoStartApi && <AutoStartVoteSection api={autoStartApi} />}
		</div>
	)
}

const DEFAULT_AUTO_START_VOTE_DELAY = SETTINGS.PublicServerSettingsSchema.parse({}).vote.autoStartVoteDelay ?? 0

// api is rooted at vote.autoStartVoteDelay, which is null when votes are only started by hand
function AutoStartVoteSection({ api }: { api: PoolConfigApi }) {
	const checkboxId = React.useId()
	const inputId = React.useId()
	const delay = usePoolValue(api, ROOT_PATH) as number | null
	const enabled = delay !== null
	const [invalid, setInvalid] = React.useState(false)
	const setDelay = useDebounced({
		onChange: (text: string) => {
			const ms = ZodUtils.tryParseHumanTimeToken(text.trim())
			setInvalid(ms === undefined)
			if (ms !== undefined) api.set(ROOT_PATH, ms)
		},
		delay: 250,
	})
	return (
		<div data-tour="pool-auto-start-vote" className="space-y-3">
			<h4 className={cn(Typo.H4, 'text-sm font-medium text-muted-foreground')}>{tr.text(SETTINGS_Msgs.startingVotes())}</h4>
			<div className="flex items-start gap-2.5">
				<PermissionDeniedTooltip denied={api.writeDenied}>
					<Checkbox
						id={checkboxId}
						className="mt-0.5"
						checked={enabled}
						disabled={!!api.writeDenied}
						onCheckedChange={(next) => {
							setInvalid(false)
							api.set(ROOT_PATH, next ? DEFAULT_AUTO_START_VOTE_DELAY : null)
						}}
					/>
				</PermissionDeniedTooltip>
				<div className="min-w-0 space-y-1">
					<Label htmlFor={checkboxId} className="cursor-pointer font-medium">
						{tr.text(SETTINGS_Msgs.autoStartVotesLabel())}
					</Label>
					<p className="text-sm text-muted-foreground">{tr.text(SETTINGS_Msgs.autoStartVotesHelp())}</p>
				</div>
			</div>
			<div className="space-y-1 ps-6">
				<Label htmlFor={inputId} className="text-sm font-medium">
					{tr.text(SETTINGS_Msgs.autoStartVoteDelay())}
				</Label>
				{/* toggling remounts it, so the box re-seeds from the value the checkbox just wrote */}
				<Input
					key={`${api.resetKey}:${enabled}`}
					id={inputId}
					defaultValue={delay === null ? '' : ZodUtils.formatHumanTime(delay)}
					placeholder={ZodUtils.formatHumanTime(DEFAULT_AUTO_START_VOTE_DELAY)}
					disabled={!enabled || !!api.writeDenied}
					aria-invalid={invalid}
					onChange={(e) => setDelay(e.target.value)}
					containerClassName="w-32"
				/>
				{invalid && <p className="text-xs text-destructive">{tr.text(SETTINGS_Msgs.autoStartVoteDelayInvalid())}</p>}
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

// On a phone each row is a card instead: the table's columns need ~1000px.
const RULE_ROW_GRID = cn(
	'grid grid-cols-[auto_minmax(0,2fr)_minmax(0,2fr)_60px_minmax(0,3fr)_minmax(240px,2fr)_auto] items-center gap-2',
	"max-phone:items-end max-phone:grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)_auto] max-phone:[grid-template-areas:'grip_label_label_del'_'field_field_within_within'_'targets_targets_targets_targets'_'options_options_options_options']",
)

// a row's grid item on desktop; on a phone, a captioned block placed by grid area
function RuleCell(props: { className: string; caption?: string; children: React.ReactNode }) {
	return (
		<div className={cn('contents max-phone:flex max-phone:min-w-0 max-phone:flex-col max-phone:gap-1', props.className)}>
			{props.caption && <span className="hidden text-xs font-medium text-muted-foreground max-phone:block">{props.caption}</span>}
			{props.children}
		</div>
	)
}

// A rule's name is its label, or its field when it has none. Most rules never get one, so the box only appears
// once asked for; emptying it again unsets the label, and the button comes back when the row next re-seeds.
function RuleLabelCell(props: { label: string | undefined; disabled: boolean; onChange: (label: string) => void }) {
	const [open, setOpen] = React.useState(props.label !== undefined)
	const setLabel = useDebounced({ onChange: props.onChange, delay: 250 })
	if (!open) {
		return (
			<Button
				variant="ghost"
				disabled={props.disabled}
				onClick={() => setOpen(true)}
				className="h-8 w-full justify-start border border-dashed px-3 font-normal text-muted-foreground max-phone:h-(--ctl)"
			>
				<Icons.Plus className="me-2 h-3 w-3" />
				{tr.text(SETTINGS_Msgs.repeatRuleAddLabel())}
			</Button>
		)
	}
	return (
		<Input
			autoFocus={props.label === undefined}
			aria-label={tr.text(SETTINGS_Msgs.repeatRuleLabel())}
			placeholder={tr.text(SETTINGS_Msgs.repeatRuleLabel())}
			defaultValue={props.label ?? ''}
			disabled={props.disabled}
			onChange={(e) => setLabel(e.target.value)}
			className="h-8 max-phone:h-(--ctl)"
		/>
	)
}

function RepeatRuleRow(props: {
	index: number
	panelId: string
	api: PoolConfigApi
	// signals the panel to remount the (uncontrolled) rows so they re-seed once a delete or a reorder shifts them
	onStructural: () => void
}) {
	const { index, api, onStructural } = props
	const rulePath = [index]

	const rule = usePoolValue(api, rulePath) as RRS.RepeatRuleConfig
	const drag = DndKit.useDraggable({ type: 'repeat-rule', id: ruleDragId(props.panelId, index) }, { feedback: 'default' })

	// an empty box is how a label is taken away again, so it unsets rather than saving ''
	const setLabel = (label: string) => api.set([...rulePath, 'label'], label.trim() || undefined)

	const setField = (field: LQY.RepeatRuleField) => {
		api.set([...rulePath, 'field'], field)
		if (!LQY.isTeamSpecificRepeatRuleField(field)) api.set([...rulePath, 'crossTeam'], undefined)
		// values named for the old field match nothing under the new one, which would leave the rule silently inert
		api.set([...rulePath, 'targetValues'], undefined)
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
		const rules = api.getValue([]) as LQY.RepeatRule[]
		api.set(
			[],
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
			className={cn(RULE_ROW_GRID, 'rounded-md bg-background data-[dragging=true]:opacity-40 max-phone:border max-phone:p-2')}
		>
			<button
				type="button"
				ref={drag.handleRef}
				disabled={!!api.writeDenied}
				className="cursor-grab rounded text-muted-foreground disabled:cursor-not-allowed disabled:opacity-40 max-phone:self-center max-phone:[grid-area:grip]"
				aria-label={tr.text(SETTINGS_Msgs.repeatRuleReorder())}
			>
				<Icons.GripVertical className="h-4 w-4" />
			</button>
			<RuleCell className="max-phone:[grid-area:label]">
				<RuleLabelCell label={rule.label} disabled={!!api.writeDenied} onChange={setLabel} />
			</RuleCell>
			<RuleCell className="max-phone:[grid-area:field]" caption={tr.text(SETTINGS_Msgs.repeatRuleField())}>
				<ComboBox
					className="max-phone:h-(--ctl) max-phone:w-full"
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
			</RuleCell>
			<RuleCell className="max-phone:[grid-area:within]" caption={tr.text(SETTINGS_Msgs.repeatRuleWithin())}>
				<Input
					type="number"
					defaultValue={rule.within}
					disabled={!!api.writeDenied}
					onChange={(e) => {
						setWithin(Math.floor(Number(e.target.value)))
					}}
					className="h-8 max-phone:h-(--ctl)"
				/>
			</RuleCell>
			<RuleCell className="max-phone:[grid-area:targets]" caption={tr.text(SETTINGS_Msgs.repeatRuleTargetValues())}>
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
			</RuleCell>
			<RuleCell className="max-phone:[grid-area:options]" caption={tr.text(SETTINGS_Msgs.repeatRuleOptions())}>
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
			</RuleCell>
			<RuleCell className="max-phone:[grid-area:del]">
				<PermissionDeniedTooltip denied={api.writeDenied}>
					<Button
						size="icon"
						variant="outline"
						onClick={deleteRule}
						disabled={!!api.writeDenied}
						className="h-8 w-8 max-phone:size-(--ctl)"
					>
						<Icons.Minus className="h-4 w-4" />
					</Button>
				</PermissionDeniedTooltip>
			</RuleCell>
		</li>
	)
}

// api is rooted at the list of rules (see useRepeatRulesetRulesApi)
function RepeatRulesTable(props: { api: PoolConfigApi }) {
	const { api } = props
	const panelId = React.useId()
	const rulesLength = ((usePoolValue(api, []) as LQY.RepeatRule[] | null) ?? []).length
	// remounts the uncontrolled rows after edits that shift or rewrite their seeded values
	const [structuralKey, setStructuralKey] = React.useState(0)
	const onStructural = () => setStructuralKey((k) => k + 1)

	const addRule = () => {
		const rules = (api.getValue([]) as LQY.RepeatRule[] | null) ?? []
		api.set([], [...rules, { field: 'Map', within: 0, indicate: true, warn: true }])
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
			const rules = (api.getValue([]) as RRS.RepeatRuleConfig[] | null) ?? []
			const reordered = Arr.moveItem(rules, from.idx, to.idx, slot.position)
			if (reordered === rules) return
			api.set([], reordered)
			onStructural()
		}, []),
	)

	return (
		<div data-tour="pool-repeat-rules" className="space-y-3">
			<span className="flex items-center gap-2">
				<h4 className={cn(Typo.H4, 'text-sm font-medium text-muted-foreground')}>{tr.text(SETTINGS_Msgs.repeatRules())}</h4>
				<ConstraintViolationIcon />
			</span>
			<div className="border rounded-md p-3 max-phone:p-2">
				<div className={cn(RULE_ROW_GRID, 'text-sm font-medium text-muted-foreground max-phone:hidden')}>
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
				<PermissionDeniedTooltip denied={api.writeDenied}>
					<Button size="sm" variant="ghost" className="mt-2" disabled={!!api.writeDenied} onClick={addRule}>
						<Icons.Plus className="h-4 w-4" />
						{tr.text(SETTINGS_Msgs.addRepeatRule())}
					</Button>
				</PermissionDeniedTooltip>
			</div>
		</div>
	)
}

// The ruleset a server uses, read and written through poolApi as part of the server's (unsaved) settings.
export function PoolRepeatRulesetPanel(props: {
	className?: string
	poolApi: PoolConfigApi
	repeatRulesetEditor: RepeatRulesetEditorFrame.Key
	inlineSave?: boolean
}) {
	const { poolApi } = props
	const repeatRulesetId = (usePoolValue(poolApi, ['repeatRulesetId']) as RRS.RulesetId | null) ?? null
	return (
		<RepeatRulesetPanel
			className={props.className}
			title={tr.text(SETTINGS_Msgs.repeatRuleset())}
			help={tr.text(SETTINGS_Msgs.repeatRulesetHelp())}
			repeatRulesetId={repeatRulesetId}
			selectDisabled={!!poolApi.writeDenied}
			onSelect={(id) => poolApi.set(['repeatRulesetId'], id)}
			repeatRulesetEditor={props.repeatRulesetEditor}
			inlineSave={props.inlineSave}
		/>
	)
}

// A ruleset picker and the rules in the chosen ruleset. The rules are a draft in the ruleset editor frame, saved by
// the host alongside its own changes, or by the panel's own save button when `inlineSave` is set.
export function RepeatRulesetPanel(props: {
	className?: string
	title: string
	help: string
	repeatRulesetId: RRS.RulesetId | null
	onSelect: (id: RRS.RulesetId | null) => void
	selectDisabled: boolean
	repeatRulesetEditor: RepeatRulesetEditorFrame.Key
	inlineSave?: boolean
	// the rules, Save Ruleset and reset open in a dialog instead of rendering in the panel, for narrow hosts
	rulesInDialog?: boolean
}) {
	const { repeatRulesetEditor, repeatRulesetId } = props
	const [rulesOpen, setRulesOpen] = React.useState(false)
	const [nameDialog, setNameDialog] = React.useState<'new' | 'rename' | null>(null)
	const canWriteRepeatRulesets = !RbacClient.useAccess('settings.global.saveRepeatRuleset')
	const rulesApi = useRepeatRulesetRulesApi(repeatRulesetEditor)
	const rulesets = Zus.useStore(SettingsClient.PublicSettingsStore, SettingsClient.selectRepeatRulesets)
	const servers = Zus.useStore(SettingsClient.PublicSettingsStore, (s) => s?.servers)
	const [saved, modified, conflict, saving] = Zus.useStore(
		repeatRulesetEditor,
		Zus.useShallow((s) => [s.saved, s.modified, s.conflict, s.saving] as const),
	)

	const otherServers =
		repeatRulesetId === null
			? 0
			: (servers ?? []).filter((server) => server.repeatRulesetId === repeatRulesetId && server.id !== saved?.ownerServerId).length
	const owner = saved?.ownerServerId ? servers?.find((server) => server.id === saved.ownerServerId) : undefined
	const options = rulesets.map((r) => ({ value: r.id, label: r.name }))
	const unknown = repeatRulesetId !== null && !saved

	return (
		<div className={cn('space-y-4', props.className)}>
			<div className="space-y-2">
				<span className="flex items-center gap-2">
					<h4 className={cn(Typo.H4, 'text-sm font-medium text-muted-foreground')}>{props.title}</h4>
					<HelpTooltip label={props.title}>{props.help}</HelpTooltip>
				</span>
				<div className="flex flex-wrap items-center gap-2">
					<ComboBox
						className="w-72 max-w-full"
						title={tr.text(SETTINGS_Msgs.repeatRulesetPicker())}
						placeholder={tr.text(SETTINGS_Msgs.noRepeatRuleset())}
						options={options}
						value={repeatRulesetId ?? undefined}
						allowEmpty
						disabled={props.selectDisabled}
						onSelect={(value) => props.onSelect(value ?? null)}
					/>
					{canWriteRepeatRulesets && saved && (
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={tr.text(SETTINGS_Msgs.renameRepeatRuleset())}
							title={tr.text(SETTINGS_Msgs.renameRepeatRuleset())}
							onClick={() => setNameDialog('rename')}
						>
							<Icons.Pencil />
						</Button>
					)}
					{saved && props.rulesInDialog && (
						<>
							<Button variant="outline" size="sm" onClick={() => setRulesOpen(true)}>
								<Icons.Repeat2 />
								{tr.text(
									rulesApi.writeDenied
										? SETTINGS_Msgs.viewRepeatRules(saved.rules.length)
										: SETTINGS_Msgs.editRepeatRules(saved.rules.length),
								)}
							</Button>
							{/* the draft outlives the dialog, so edits left unsaved are flagged here */}
							{modified && <Badge variant="edited">{tr.text(SETTINGS_Msgs.repeatRulesetUnsaved())}</Badge>}
						</>
					)}
				</div>
				<div className="flex flex-wrap items-center gap-2 empty:hidden">
					{canWriteRepeatRulesets && !props.selectDisabled && (
						<Button variant="outline" size="sm" onClick={() => setNameDialog('new')}>
							<Icons.Plus />
							{tr.text(SETTINGS_Msgs.newRepeatRuleset())}
						</Button>
					)}
					{owner && (
						<span className="rounded border px-1.5 py-0.5 text-xs text-muted-foreground">
							{tr.text(SETTINGS_Msgs.ownRepeatRuleset(owner.displayName))}
						</span>
					)}
					{otherServers > 0 && (
						<span className="text-xs text-muted-foreground">{tr.text(SETTINGS_Msgs.repeatRulesetSharedWith(otherServers))}</span>
					)}
				</div>
				{repeatRulesetId === null && <p className="text-sm text-muted-foreground">{tr.text(SETTINGS_Msgs.noRepeatRulesetBlurb())}</p>}
				{unknown && (
					<Alert variant="destructive">
						<AlertDescription>{tr.text(SETTINGS_Msgs.unknownRepeatRuleset(repeatRulesetId))}</AlertDescription>
					</Alert>
				)}
				{conflict && (
					<Alert variant="warning">
						<AlertDescription>{tr.text(SETTINGS_Msgs.repeatRulesetConflict())}</AlertDescription>
					</Alert>
				)}
			</div>
			{saved && props.rulesInDialog && (
				<Dialog open={rulesOpen} onOpenChange={setRulesOpen}>
					<DialogContent className="max-w-5xl min-w-[min(1040px,95vw)]">
						<DialogHeader>
							<DialogTitle>{tr.text(SETTINGS_Msgs.repeatRulesOf(saved.name))}</DialogTitle>
						</DialogHeader>
						{conflict && (
							<Alert variant="warning">
								<AlertDescription>{tr.text(SETTINGS_Msgs.repeatRulesetConflict())}</AlertDescription>
							</Alert>
						)}
						<RepeatRulesTable api={rulesApi} />
						{props.inlineSave && !rulesApi.writeDenied && (
							<RepeatRulesetSaveRow repeatRulesetEditor={repeatRulesetEditor} modified={modified} saving={saving} />
						)}
					</DialogContent>
				</Dialog>
			)}
			{nameDialog && (
				<RepeatRulesetNameDialog
					mode={nameDialog}
					rulesets={rulesets}
					current={saved}
					onClose={() => setNameDialog(null)}
					onSubmit={async (name) => {
						if (nameDialog === 'rename') return await RepeatRulesetEditorFrame.Actions.rename({ repeatRulesetEditor }, name)
						const rules = saved ? Zus.getState(repeatRulesetEditor).draft : RRS.DEFAULT_RULES
						const id = await RepeatRulesetEditorFrame.Actions.create(name, rules)
						if (id) props.onSelect(id)
						return id !== null
					}}
				/>
			)}
			{saved && !props.rulesInDialog && <RepeatRulesTable api={rulesApi} />}
			{saved && !props.rulesInDialog && props.inlineSave && !rulesApi.writeDenied && (
				<RepeatRulesetSaveRow repeatRulesetEditor={repeatRulesetEditor} modified={modified} saving={saving} />
			)}
		</div>
	)
}

// names a new ruleset, or renames the one being edited
function RepeatRulesetNameDialog(props: {
	mode: 'new' | 'rename'
	rulesets: readonly RRS.Ruleset[]
	current: RRS.Ruleset | undefined
	onClose: () => void
	onSubmit: (name: string) => Promise<boolean>
}) {
	const initial =
		props.mode === 'rename' ? (props.current?.name ?? '') : RRS.freeName(props.rulesets, tr.text(SETTINGS_Msgs.newRepeatRulesetName()))
	const [name, setName] = React.useState(initial)
	const [submitting, setSubmitting] = React.useState(false)
	const nameId = React.useId()
	const trimmed = name.trim()
	const taken = RRS.nameTaken(props.rulesets, trimmed, props.mode === 'rename' ? props.current?.id : undefined)
	const canSubmit = trimmed.length > 0 && !taken && !submitting && (props.mode === 'new' || trimmed !== props.current?.name)

	const submit = async () => {
		if (!canSubmit) return
		setSubmitting(true)
		try {
			if (await props.onSubmit(trimmed)) props.onClose()
		} finally {
			setSubmitting(false)
		}
	}

	return (
		<Dialog open onOpenChange={(open) => !open && props.onClose()}>
			<DialogContent className="max-w-sm">
				<DialogHeader>
					<DialogTitle>
						{tr.text(props.mode === 'new' ? SETTINGS_Msgs.newRepeatRuleset() : SETTINGS_Msgs.renameRepeatRuleset())}
					</DialogTitle>
					{props.mode === 'new' && (
						<DialogDescription>
							{tr.text(
								props.current ? SETTINGS_Msgs.newRepeatRulesetCopies(props.current.name) : SETTINGS_Msgs.newRepeatRulesetDefaults(),
							)}
						</DialogDescription>
					)}
				</DialogHeader>
				<div className="space-y-1">
					<Label htmlFor={nameId}>{tr.text(SETTINGS_Msgs.repeatRulesetName())}</Label>
					<Input
						id={nameId}
						autoFocus
						defaultValue={initial}
						maxLength={RRS.MAX_NAME_LENGTH}
						onChange={(e) => setName(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter') void submit()
						}}
					/>
					{taken && <p className="text-xs text-destructive">{tr.text(SETTINGS_Msgs.repeatRulesetNameTaken(trimmed))}</p>}
				</div>
				<DialogFooter>
					<Button variant="outline" onClick={props.onClose}>
						{tr.text(UI_Msgs.cancel())}
					</Button>
					<Button variant="primary" disabled={!canSubmit} onClick={() => void submit()}>
						{submitting && <Spinner className="animate-spin" />}
						{tr.text(props.mode === 'new' ? SETTINGS_Msgs.createRepeatRuleset() : SETTINGS_Msgs.saveRepeatRulesetName())}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

function RepeatRulesetSaveRow(props: { repeatRulesetEditor: RepeatRulesetEditorFrame.Key; modified: boolean; saving: boolean }) {
	const stores = { repeatRulesetEditor: props.repeatRulesetEditor }
	return (
		<div className="flex items-center justify-end gap-2">
			<Button
				size="icon"
				variant="ghost"
				disabled={!props.modified || props.saving}
				onClick={() => RepeatRulesetEditorFrame.Actions.reset(stores)}
			>
				<Icons.Undo className="h-4 w-4 rtl:-scale-x-100" />
				<span className="sr-only">{tr.text(SETTINGS_Msgs.resetChanges())}</span>
			</Button>
			<Button
				variant="primary"
				disabled={!props.modified || props.saving}
				onClick={() => void RepeatRulesetEditorFrame.Actions.save(stores)}
			>
				{props.saving && <Spinner className="animate-spin" />}
				{tr.text(SETTINGS_Msgs.saveRepeatRuleset())}
			</Button>
		</div>
	)
}
