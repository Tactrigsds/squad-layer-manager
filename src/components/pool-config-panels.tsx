import { PermissionDeniedTooltip } from '@/components/permission-denied-tooltip'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useDebounced } from '@/hooks/use-debounce.ts'
import * as Arr from '@/lib/array'
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
import FilterEntitySelect from './filter-entity-select.tsx'
import type { PoolConfigApi } from './pool-config-panels.helpers.ts'
import { Checkbox } from './ui/checkbox.tsx'
import { Input } from './ui/input.tsx'
import { TriStateCheckbox } from './ui/tri-state-checkbox.tsx'

// Shared pool-configuration UI (filters + repeat rules for the main/generation pools), used by both the dashboard's
// server-settings popover and the settings page's server forms. All data access goes through PoolConfigApi so the
// two hosts can plug in their own editing substrate (ops-based store vs draft observable).

export function MainPoolFiltersPanel({ api }: { api: PoolConfigApi }) {
	const filtersPath = ['filters']
	const filterConfigs = (api.useValue(filtersPath) as SETTINGS.PoolFilterConfig[] | null) ?? []
	const filterEntities = FilterEntityClient.useFilterEntities()

	const add = (filterId: F.FilterEntityId | null) => {
		if (filterId === null) return
		const newFilters: SETTINGS.PoolFilterConfig[] = [...filterConfigs, {
			filterId,
			defaultApplyDuringLayerSelection: SETTINGS.DEFAULT_POOL_FILTER_APPLY_AS,
		}]
		api.set(filtersPath, newFilters)
	}

	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between">
				<h4 className={cn(Typography.H4, 'text-sm font-medium text-muted-foreground')}>Filters</h4>
				<PermissionDeniedTooltip denied={api.writeDenied}>
					<FilterEntitySelect
						title="New Pool Filter"
						filterId={null}
						onSelect={add}
						excludedFilterIds={Arr.deref('filterId', filterConfigs)}
						allowEmpty={false}
						enabled={!api.writeDenied}
					>
						<Button disabled={!!api.writeDenied} size="sm" variant="outline">
							<Icons.Plus className="h-4 w-4 mr-2" />
							Add Filter
						</Button>
					</FilterEntitySelect>
				</PermissionDeniedTooltip>
			</div>
			<div className="border rounded-md p-3">
				<div
					className="grid gap-2 items-center"
					style={{ gridTemplateColumns: 'minmax(0, auto) max-content max-content max-content max-content max-content' }}
				>
					{/* Header Row */}
					<div className="contents text-sm font-medium text-muted-foreground">
						<div>Filter</div>
						<div>Layer Default Select</div>
						<div>In Pool</div>
						<div>Indicate</div>
						<div>Warn</div>
						<div></div>
					</div>
					{/* Filter Rows */}
					{filterConfigs.map((filterConfig, i) => {
						const filterId = filterConfig.filterId
						const filterPath = [...filtersPath, i]
						const filter = filterEntities.get(filterId)
						if (!filter) return
						const onSelect = (newFilterId: string | null) => {
							if (newFilterId === null || newFilterId === filterId) {
								return
							}
							const newValue: SETTINGS.PoolFilterConfig = {
								filterId: newFilterId,
								defaultApplyDuringLayerSelection: SETTINGS.DEFAULT_POOL_FILTER_APPLY_AS,
							}
							api.set(filterPath, newValue)
						}
						const deleteFilter = () => {
							const filterConfigs = api.getValue(filtersPath) as SETTINGS.PoolFilterConfig[]
							api.set(filtersPath, filterConfigs.filter((c) => c.filterId !== filterConfig.filterId))
						}
						const excludedFilterIds = filterConfigs.flatMap((c) => filterId !== c.filterId ? [c.filterId] : [])
						const defaultApplyDescriptions: { [k in SETTINGS.PoolFilterDefaultApplyAsSetting]: string } = {
							regular: 'Regular',
							inverted: 'Inverted',
							disabled: 'Disabled',
							hidden: 'Hidden',
						}
						const indicateDescriptions: { [k in LQY.IndicatorState]: string } = {
							regular: 'Matches',
							inverted: 'Non-matches',
							disabled: 'Disabled',
							both: 'Both',
						}
						const warnDescriptions: { [k in SETTINGS.PoolFilterApplyAs]: string } = {
							regular: 'Warn when a layer matching this filter is queued or about to be played',
							inverted: 'Warn when a layer NOT matching this filter is queued or about to be played',
							disabled: 'No warning',
						}
						const inPoolDescriptions: { [k in SETTINGS.PoolFilterApplyAs]: string } = {
							regular: 'Layers must match this filter to be in the pool',
							inverted: 'Layers must NOT match this filter to be in the pool',
							disabled: 'Does not define the pool',
						}
						const canWarn = !!filterConfig.showIndicator && filterConfig.showIndicator !== 'disabled'
						const handleIndicateMatchesChanged = (_newValue: LQY.IndicatorState | undefined) => {
							const newValue = _newValue ?? 'disabled'
							const newConfig: SETTINGS.PoolFilterConfig = {
								...filterConfig,
								showIndicator: newValue,
								warn: newValue === 'disabled' ? undefined : filterConfig.warn,
							}
							api.set(filterPath, newConfig)
						}
						const handleDefaultApplyChanged = (_newValue: SETTINGS.PoolFilterDefaultApplyAsSetting | undefined) => {
							api.set([...filterPath, 'defaultApplyDuringLayerSelection'], _newValue ?? 'disabled')
						}
						const handleWarnChanged = (newWarn: SETTINGS.PoolFilterApplyAs) => {
							api.set([...filterPath, 'warn'], newWarn)
						}
						const handleInPoolChanged = (_newValue: SETTINGS.PoolFilterApplyAs | undefined) => {
							api.set([...filterPath, 'inPool'], _newValue ?? 'disabled')
						}

						return (
							<React.Fragment key={filterId}>
								<FilterEntitySelect
									enabled={!api.writeDenied}
									title="Pool Filter"
									filterId={filterId}
									onSelect={onSelect}
									allowToggle={false}
									allowEmpty={false}
									excludedFilterIds={excludedFilterIds}
								/>
								<ComboBox
									title="Default Apply"
									options={SETTINGS.POOL_FILTER_DEFAULT_APPLY_AS_SETTING.options.map(v => ({
										value: v,
										label: defaultApplyDescriptions[v],
									}))}
									value={filterConfig.defaultApplyDuringLayerSelection ?? 'disabled'}
									allowEmpty={false}
									onSelect={handleDefaultApplyChanged}
									disabled={!!api.writeDenied}
								/>
								<ComboBox
									title="In Pool"
									options={SETTINGS.POOL_FILTER_APPLY_AS.options.map(v => ({ value: v, label: inPoolDescriptions[v] }))}
									value={filterConfig.inPool ?? 'disabled'}
									allowEmpty={false}
									onSelect={handleInPoolChanged}
									disabled={!!api.writeDenied}
								/>
								<ComboBox
									title="Indicator State"
									options={LQY.INDICATOR_STATE.options.map(v => ({ value: v, label: indicateDescriptions[v] }))}
									value={filterConfig.showIndicator ?? 'disabled' as const}
									allowEmpty={false}
									onSelect={handleIndicateMatchesChanged}
									disabled={!!api.writeDenied}
								/>
								<div className="border border-input rounded-md flex items-center justify-center">
									<TriStateCheckbox
										checked={filterConfig.warn}
										onCheckedChange={handleWarnChanged}
										disabled={!canWarn || !!api.writeDenied}
										title={canWarn ? warnDescriptions[filterConfig.warn ?? 'disabled'] : 'Enable "Indicate" first'}
									/>
								</div>
								<div className="contents">
									<PermissionDeniedTooltip denied={api.writeDenied}>
										<Button
											disabled={!!api.writeDenied}
											size="icon"
											variant="outline"
											onClick={deleteFilter}
											className="h-8 w-8"
										>
											<Icons.Minus className="h-4 w-4" />
										</Button>
									</PermissionDeniedTooltip>
								</div>
							</React.Fragment>
						)
					})}
				</div>
			</div>
		</div>
	)
}

export function GenerationPoolFiltersPanel({ api }: { api: PoolConfigApi }) {
	const filtersPath = ['filters']
	const filterConfigs = (api.useValue(filtersPath) as SETTINGS.GenerationFilterConfig[] | null) ?? []
	const filterEntities = FilterEntityClient.useFilterEntities()

	const add = (filterId: F.FilterEntityId | null) => {
		if (filterId === null) return
		const newFilters: SETTINGS.GenerationFilterConfig[] = [...filterConfigs, { filterId, applyAs: 'regular' }]
		api.set(filtersPath, newFilters)
	}

	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between">
				<h4 className={cn(Typography.H4, 'text-sm font-medium text-muted-foreground')}>Filters</h4>
				<PermissionDeniedTooltip denied={api.writeDenied}>
					<FilterEntitySelect
						title="New Pool Filter"
						filterId={null}
						onSelect={add}
						excludedFilterIds={Arr.deref('filterId', filterConfigs)}
						allowEmpty={false}
						enabled={!api.writeDenied}
					>
						<Button disabled={!!api.writeDenied} size="sm" variant="outline">
							<Icons.Plus className="h-4 w-4 mr-2" />
							Add Filter
						</Button>
					</FilterEntitySelect>
				</PermissionDeniedTooltip>
			</div>
			<div className="border rounded-md p-3">
				<div
					className="grid gap-2 items-center"
					style={{ gridTemplateColumns: 'minmax(0, auto) max-content max-content' }}
				>
					<div className="contents text-sm font-medium text-muted-foreground">
						<div>Filter</div>
						<div>Apply As</div>
						<div></div>
					</div>
					{filterConfigs.map((filterConfig, i) => {
						const filterId = filterConfig.filterId
						const filterPath = [...filtersPath, i]
						const filter = filterEntities.get(filterId)
						if (!filter) return
						const excludedFilterIds = filterConfigs.flatMap((c) => filterId !== c.filterId ? [c.filterId] : [])
						const onSelect = (newFilterId: string | null) => {
							if (newFilterId === null || newFilterId === filterId) return
							api.set(filterPath, { filterId: newFilterId, applyAs: filterConfig.applyAs })
						}
						const deleteFilter = () => {
							const configs = api.getValue(filtersPath) as SETTINGS.GenerationFilterConfig[]
							api.set(filtersPath, configs.filter((c) => c.filterId !== filterId))
						}
						const handleApplyAsChanged = (newValue: SETTINGS.PoolFilterApplyAs) => {
							api.set([...filterPath, 'applyAs'], newValue)
						}
						return (
							<React.Fragment key={filterId}>
								<FilterEntitySelect
									enabled={!api.writeDenied}
									title="Pool Filter"
									filterId={filterId}
									onSelect={onSelect}
									allowToggle={false}
									allowEmpty={false}
									excludedFilterIds={excludedFilterIds}
								/>
								<div className="border border-input rounded-md flex items-center justify-center">
									<TriStateCheckbox
										checked={filterConfig.applyAs}
										onCheckedChange={handleApplyAsChanged}
										disabled={!!api.writeDenied}
									/>
								</div>
								<div className="contents">
									<PermissionDeniedTooltip denied={api.writeDenied}>
										<Button
											disabled={!!api.writeDenied}
											size="icon"
											variant="outline"
											onClick={deleteFilter}
											className="h-8 w-8"
										>
											<Icons.Minus className="h-4 w-4" />
										</Button>
									</PermissionDeniedTooltip>
								</div>
							</React.Fragment>
						)
					})}
				</div>
			</div>
		</div>
	)
}

function RepeatRuleRow(props: {
	index: number
	poolId: 'mainPool' | 'generationPool'
	api: PoolConfigApi
	// signals the panel to remount the (uncontrolled) rows so they re-seed after a shift/programmatic label change
	onStructural: () => void
}) {
	const { index, poolId, api, onStructural } = props
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
			{poolId === 'mainPool' && (
				<div className="contents">
					<Checkbox
						checked={!!rule.warn}
						disabled={!!api.writeDenied}
						onCheckedChange={(checked) => setWarn(checked === true)}
					/>
				</div>
			)}
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
	poolId: 'mainPool' | 'generationPool'
	api: PoolConfigApi
}) {
	const { poolId, api } = props
	const rulesPath = ['repeatRules']
	const rulesLength = ((api.useValue(rulesPath) as LQY.RepeatRule[] | null) ?? []).length
	// remounts the uncontrolled rows after edits that shift or rewrite their seeded values
	const [structuralKey, setStructuralKey] = React.useState(0)
	const onStructural = () => setStructuralKey((k) => k + 1)

	const addRule = () => {
		const rules = (api.getValue(rulesPath) as LQY.RepeatRule[] | null) ?? []
		api.set(rulesPath, [...rules, { field: 'Map', within: 0, label: 'Map' }])
	}

	const showWarn = poolId === 'mainPool'
	const applyMainPoolRepeatRulesSwitchId = React.useId()
	// generationPool only (reads undefined on the main pool; subscribed unconditionally to keep hook order static)
	const applyMainPoolRepeatRules = !!api.useValue(['applyMainPoolRepeatRules'])
	const setApplyMainPoolRepeatRules = (checked: boolean | 'indeterminate') => {
		if (checked === 'indeterminate') return
		api.set(['applyMainPoolRepeatRules'], checked)
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
				<span className="flex items-center gap-2">
					{poolId === 'generationPool' && (
						<span className="flex items-center gap-1 text-sm text-muted-foreground">
							<Label htmlFor={applyMainPoolRepeatRulesSwitchId} className="font-normal cursor-pointer">
								Also apply main pool repeat rules
							</Label>
							<PermissionDeniedTooltip denied={api.writeDenied}>
								<Switch
									id={applyMainPoolRepeatRulesSwitchId}
									disabled={!!api.writeDenied}
									checked={applyMainPoolRepeatRules}
									onCheckedChange={setApplyMainPoolRepeatRules}
								/>
							</PermissionDeniedTooltip>
						</span>
					)}
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
				</span>
			</div>
			<div className="border rounded-md p-3">
				<div
					className="grid gap-2 items-center"
					style={{ gridTemplateColumns: showWarn ? '2fr 2fr 60px 4fr max-content max-content' : '2fr 2fr 60px 4fr max-content' }}
				>
					{/* Header Row */}
					<div className="contents text-sm font-medium text-muted-foreground">
						<div>Label</div>
						<div>Field</div>
						<div>Within</div>
						<div>Target Values</div>
						{showWarn && <div>Warn</div>}
						<div></div>
					</div>
					{/* Rules; keyed on resetKey/structuralKey too so uncontrolled inputs re-seed after structural changes/resets */}
					{Array.from({ length: rulesLength }, (_, index) => (
						<RepeatRuleRow
							key={`${api.resetKey}:${structuralKey}:${index}`}
							index={index}
							poolId={poolId}
							api={api}
							onStructural={onStructural}
						/>
					))}
				</div>
			</div>
		</div>
	)
}
