import { PermissionDeniedTooltip } from '@/components/permission-denied-tooltip'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import * as ServerSettingsPrt from '@/frame-partials/server-settings.partial'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import { useDebounced } from '@/hooks/use-debounce.ts'
import * as Arr from '@/lib/array'
import { assertNever } from '@/lib/type-guards.ts'
import * as Typography from '@/lib/typography.ts'
import { cn } from '@/lib/utils.ts'
import { devValidate } from '@/lib/zod.dev.ts'
import * as ZusUtils from '@/lib/zustand'
import type * as F from '@/models/filter.models.ts'
import * as L from '@/models/layer'
import * as LQY from '@/models/layer-queries.models.ts'
import * as SETTINGS from '@/models/settings.models.ts'
import * as UP from '@/models/user-presence'
import * as RBAC from '@/rbac.models'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import * as RbacClient from '@/systems/rbac.client'
import * as UPClient from '@/systems/user-presence.client'
import * as Im from 'immer'
import * as Icons from 'lucide-react'
import React from 'react'
import ComboBoxMulti from './combo-box/combo-box-multi.tsx'
import ComboBox from './combo-box/combo-box.tsx'
import { ConstraintViolationIcon } from './constraint-matches-indicator.tsx'
import FilterEntitySelect from './filter-entity-select.tsx'
import { Alert, AlertDescription } from './ui/alert.tsx'
import { Checkbox } from './ui/checkbox.tsx'
import { Input } from './ui/input.tsx'
import TabsList from './ui/tabs-list.tsx'
import { TriStateCheckbox } from './ui/tri-state-checkbox.tsx'

export type ServerSettingsPopoverHandle = {
	reset(settings: SETTINGS.ServerSettings): void
}

export default function ServerSettingsPopover(
	props: {
		children: React.ReactNode
		ref?: React.ForwardedRef<ServerSettingsPopoverHandle>
		stores: SquadServerFrame.KeyProp
	},
) {
	const stores = props.stores
	React.useImperativeHandle(props.ref, () => ({
		reset: () => {},
	}))

	const [poolId, setPoolId] = React.useState<'mainPool' | 'generationPool'>('mainPool')

	const [open, _setOpen] = UPClient.useActivityState(UP.Trans.viewingSettings(stores.squadServer!.serverId))
	const setOpen = (open: boolean) => {
		if (!open) {
			ServerSettingsPrt.Actions.reset({ settings: stores.squadServer! })
		}
		_setOpen(open)
	}

	const [settingsChanged, saving, validationErrors] = ZusUtils.useStore(
		stores.squadServer!,
		ZusUtils.useShallow(s => [s.settings.modified, s.settings.saving, s.settings.validationErrors]),
	)

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>{props.children}</PopoverTrigger>
			<PopoverContent
				className="w-200 flex flex-col space-y-4 p-6"
				side="left"
				align="start"
			>
				<div className="flex items-center justify-between border-b pb-3">
					<h3 className="text-lg font-semibold">Pool Configuration</h3>
					<div className="flex items-center space-x-2">
						<TabsList
							options={[
								{ label: 'Main Pool', value: 'mainPool' },
								{ label: 'Autogeneration', value: 'generationPool' },
							]}
							active={poolId}
							setActive={setPoolId}
						/>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									size="icon"
									variant="ghost"
									disabled={!settingsChanged || saving}
									onClick={() => {
										ServerSettingsPrt.Actions.reset({ settings: stores.squadServer! })
									}}
								>
									<Icons.Trash className="h-4 w-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								<p>Reset changes</p>
							</TooltipContent>
						</Tooltip>
					</div>
				</div>
				<div className="space-y-6">
					{poolId === 'mainPool'
						? <PoolFiltersConfigurationPanel stores={stores} />
						: <GenerationPoolFiltersPanel stores={stores} />}
					<PoolRepeatRulesConfigurationPanel
						className={poolId !== 'mainPool' ? 'hidden' : undefined}
						poolId="mainPool"
						stores={stores}
					/>
					<PoolRepeatRulesConfigurationPanel
						className={poolId !== 'generationPool' ? 'hidden' : undefined}
						poolId="generationPool"
						stores={stores}
					/>
				</div>
				<div className="flex justify-end gap-2 pt-4 border-t">
					<div className="flex flex-col gap-2">
						{validationErrors && validationErrors.map((error) => (
							<Alert key={error} variant="destructive">
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						))}
					</div>
					<Button
						variant="outline"
						onClick={() => setOpen(false)}
					>
						Close
					</Button>
					<Button
						disabled={!settingsChanged || saving || !!validationErrors}
						onClick={async () => {
							const saved = await ServerSettingsPrt.Actions.save({ settings: stores.squadServer! })
							if (saved) _setOpen(false)
						}}
						className="min-w-30"
					>
						<Spinner className="invisible data-[saving=true]:visible" data-saving={saving} />
						Save Changes
						<Spinner className="invisible" />
					</Button>
				</div>
			</PopoverContent>
		</Popover>
	)
}

function PoolFiltersConfigurationPanel(props: { stores: SquadServerFrame.KeyProp }) {
	const stores = props.stores
	const filtersPath = ['queue', 'mainPool', 'filters']
	const filterConfigs = ZusUtils.useStore(
		stores.squadServer!,
		(s) => SETTINGS.derefSettingsValue(s.settings.edited, filtersPath) as SETTINGS.PoolFilterConfig[],
	)
	const filterEntities = FilterEntityClient.useFilterEntities()

	const writeSettingsDenied = RbacClient.usePermsCheck(RBAC.perm('settings:write'))

	const add = (filterId: F.FilterEntityId | null) => {
		if (filterId === null) return
		const newFilters: SETTINGS.PoolFilterConfig[] = [...filterConfigs, {
			filterId,
			defaultApplyDuringLayerSelection: SETTINGS.DEFAULT_POOL_FILTER_APPLY_AS,
		}]
		ServerSettingsPrt.Actions.set({ settings: stores.squadServer! }, { path: filtersPath, value: newFilters })
	}

	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between">
				<h4 className={cn(Typography.H4, 'text-sm font-medium text-muted-foreground')}>Filters</h4>
				<PermissionDeniedTooltip denied={writeSettingsDenied}>
					<FilterEntitySelect
						title="New Pool Filter"
						filterId={null}
						onSelect={add}
						excludedFilterIds={Arr.deref('filterId', filterConfigs)}
						allowEmpty={false}
						enabled={!writeSettingsDenied}
					>
						<Button disabled={!!writeSettingsDenied} size="sm" variant="outline">
							<Icons.Plus className="h-4 w-4 mr-2" />
							Add Filter
						</Button>
					</FilterEntitySelect>
				</PermissionDeniedTooltip>
			</div>
			<div className="border rounded-md p-3">
				<div
					className="grid gap-2 items-center"
					style={{ gridTemplateColumns: 'minmax(0, auto) max-content max-content max-content max-content' }}
				>
					{/* Header Row */}
					<div className="contents text-sm font-medium text-muted-foreground">
						<div>Filter</div>
						<div>Layer Default Select</div>
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
							ServerSettingsPrt.Actions.set({ settings: stores.squadServer! }, { path: filterPath, value: newValue })
						}
						const deleteFilter = () => {
							const edited = ZusUtils.getState(stores.squadServer!).settings.edited
							const filterConfigs = SETTINGS.derefSettingsValue(edited, filtersPath) as SETTINGS.PoolFilterConfig[]
							ServerSettingsPrt.Actions.set({ settings: stores.squadServer! }, {
								path: filtersPath,
								value: filterConfigs.filter((c) => c.filterId !== filterConfig.filterId),
							})
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
						const canWarn = !!filterConfig.showIndicator && filterConfig.showIndicator !== 'disabled'
						const handleIndicateMatchesChanged = (_newValue: LQY.IndicatorState | undefined) => {
							const newValue = _newValue ?? 'disabled'
							const newConfig: SETTINGS.PoolFilterConfig = {
								...filterConfig,
								showIndicator: newValue,
								warn: newValue === 'disabled' ? undefined : filterConfig.warn,
							}
							ServerSettingsPrt.Actions.set({ settings: stores.squadServer! }, { path: filterPath, value: newConfig })
						}
						const handleDefaultApplyChanged = (_newValue: SETTINGS.PoolFilterDefaultApplyAsSetting | undefined) => {
							const newValue = _newValue ?? 'disabled'
							ServerSettingsPrt.Actions.set({ settings: stores.squadServer! }, {
								path: [...filterPath, 'defaultApplyDuringLayerSelection'],
								value: newValue,
							})
						}
						const handleWarnChanged = (newWarn: SETTINGS.PoolFilterApplyAs) => {
							ServerSettingsPrt.Actions.set({ settings: stores.squadServer! }, { path: [...filterPath, 'warn'], value: newWarn })
						}

						return (
							<React.Fragment key={filterId}>
								<FilterEntitySelect
									enabled={!writeSettingsDenied}
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
								/>
								<ComboBox
									title="Indicator State"
									options={LQY.INDICATOR_STATE.options.map(v => ({ value: v, label: indicateDescriptions[v] }))}
									value={filterConfig.showIndicator ?? 'disabled' as const}
									allowEmpty={false}
									onSelect={handleIndicateMatchesChanged}
								/>
								<div className="border border-input rounded-md flex items-center justify-center">
									<TriStateCheckbox
										checked={filterConfig.warn}
										onCheckedChange={handleWarnChanged}
										disabled={!canWarn}
										title={canWarn ? warnDescriptions[filterConfig.warn ?? 'disabled'] : 'Enable "Indicate" first'}
									/>
								</div>
								<div className="contents">
									<PermissionDeniedTooltip denied={writeSettingsDenied}>
										<Button
											disabled={!!writeSettingsDenied}
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

function GenerationPoolFiltersPanel(props: { stores: SquadServerFrame.KeyProp }) {
	const stores = props.stores
	const filtersPath = ['queue', 'generationPool', 'filters']
	const filterConfigs = ZusUtils.useStore(
		stores.squadServer!,
		(s) => SETTINGS.derefSettingsValue(s.settings.edited, filtersPath) as SETTINGS.GenerationFilterConfig[],
	)
	const filterEntities = FilterEntityClient.useFilterEntities()
	const writeSettingsDenied = RbacClient.usePermsCheck(RBAC.perm('settings:write'))

	const add = (filterId: F.FilterEntityId | null) => {
		if (filterId === null) return
		const newFilters: SETTINGS.GenerationFilterConfig[] = [...filterConfigs, { filterId, applyAs: 'regular' }]
		ServerSettingsPrt.Actions.set({ settings: stores.squadServer! }, { path: filtersPath, value: newFilters })
	}

	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between">
				<h4 className={cn(Typography.H4, 'text-sm font-medium text-muted-foreground')}>Filters</h4>
				<PermissionDeniedTooltip denied={writeSettingsDenied}>
					<FilterEntitySelect
						title="New Pool Filter"
						filterId={null}
						onSelect={add}
						excludedFilterIds={Arr.deref('filterId', filterConfigs)}
						allowEmpty={false}
						enabled={!writeSettingsDenied}
					>
						<Button disabled={!!writeSettingsDenied} size="sm" variant="outline">
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
							ServerSettingsPrt.Actions.set({ settings: stores.squadServer! }, {
								path: filterPath,
								value: { filterId: newFilterId, applyAs: filterConfig.applyAs },
							})
						}
						const deleteFilter = () => {
							const edited = ZusUtils.getState(stores.squadServer!).settings.edited
							const configs = SETTINGS.derefSettingsValue(edited, filtersPath) as SETTINGS.GenerationFilterConfig[]
							ServerSettingsPrt.Actions.set({ settings: stores.squadServer! }, {
								path: filtersPath,
								value: configs.filter((c) => c.filterId !== filterId),
							})
						}
						const handleApplyAsChanged = (newValue: SETTINGS.PoolFilterApplyAs) => {
							ServerSettingsPrt.Actions.set({ settings: stores.squadServer! }, { path: [...filterPath, 'applyAs'], value: newValue })
						}
						return (
							<React.Fragment key={filterId}>
								<FilterEntitySelect
									enabled={!writeSettingsDenied}
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
										disabled={!!writeSettingsDenied}
									/>
								</div>
								<div className="contents">
									<PermissionDeniedTooltip denied={writeSettingsDenied}>
										<Button
											disabled={!!writeSettingsDenied}
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
	stores: SquadServerFrame.KeyProp
}) {
	const { index, poolId, stores } = props

	const paths = React.useMemo(() => {
		const rules = devValidate(SETTINGS.SettingsPathSchema, ['queue', poolId, 'repeatRules'])
		const rule = devValidate(SETTINGS.SettingsPathSchema, [...rules, index])
		return {
			rules,
			rule,
			label: devValidate(SETTINGS.SettingsPathSchema, [...rule, 'label']),
			field: devValidate(SETTINGS.SettingsPathSchema, [...rule, 'field']),
			within: devValidate(SETTINGS.SettingsPathSchema, [...rule, 'within']),
			targetValues: devValidate(SETTINGS.SettingsPathSchema, [...rule, 'targetValues']),
			warn: devValidate(SETTINGS.SettingsPathSchema, [...rule, 'warn']),
		}
	}, [poolId, index])

	const selectRuleConfig = React.useCallback(
		(s: ServerSettingsPrt.Store) => {
			return (SETTINGS.derefSettingsValue(s.settings.edited, paths.rules) as SETTINGS.PoolRepeatRuleConfig[])[index]
		},
		[paths.rules, index],
	)

	const writeSettingsDenied = RbacClient.usePermsCheck(RBAC.perm('settings:write'))
	const rule = ZusUtils.useStore(stores.squadServer!, selectRuleConfig)

	const writeLabel = React.useCallback((label: string) => {
		ServerSettingsPrt.Actions.set({ settings: stores.squadServer! }, { path: paths.label, value: label })
	}, [paths.label, stores.squadServer])

	const setLabel = useDebounced({
		onChange: writeLabel,
		delay: 250,
	})

	const setField = (field: LQY.RepeatRuleField) => {
		ServerSettingsPrt.Actions.set({ settings: stores.squadServer! }, { path: paths.field, value: field })
		ServerSettingsPrt.Actions.set({ settings: stores.squadServer! }, { path: paths.label, value: field })
	}

	const writeWithin = React.useCallback((within: number) => {
		ServerSettingsPrt.Actions.set({ settings: stores.squadServer! }, { path: paths.within, value: within })
	}, [paths.within, stores.squadServer])

	const setWithin = useDebounced({
		onChange: writeWithin,
		delay: 250,
	})

	const setTargetValues = (update: React.SetStateAction<string[]>) => {
		const edited = ZusUtils.getState(stores.squadServer!).settings.edited
		const originalValues = SETTINGS.derefSettingsValue(edited, paths.targetValues) as string[] | undefined
		const targetValues = typeof update === 'function' ? update(originalValues ?? []) : update
		ServerSettingsPrt.Actions.set({ settings: stores.squadServer! }, {
			path: paths.targetValues,
			value: targetValues.length === 0 ? undefined : targetValues,
		})
	}

	const setWarn = (warn: boolean) => {
		ServerSettingsPrt.Actions.set({ settings: stores.squadServer! }, { path: paths.warn, value: warn || undefined })
	}

	const deleteRule = () => {
		const edited = ZusUtils.getState(stores.squadServer!).settings.edited
		const rules = SETTINGS.derefSettingsValue(edited, paths.rules) as LQY.RepeatRule[]
		const updated = Im.produce(rules, (draft) => {
			draft.splice(index, 1)
		})
		ServerSettingsPrt.Actions.set({ settings: stores.squadServer! }, { path: paths.rules, value: updated })
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
					disabled={!!writeSettingsDenied}
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
					disabled={!!writeSettingsDenied}
				/>
			</div>
			<div className="contents">
				<Input
					type="number"
					defaultValue={rule.within}
					disabled={!!writeSettingsDenied}
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
					disabled={!!writeSettingsDenied}
					values={rule.targetValues ?? []}
					onSelect={(updated) => {
						setTargetValues(updated)
					}}
				/>
			</div>
			{poolId === 'mainPool' && (
				<div className="contents">
					<Checkbox
						checked={!!(rule as SETTINGS.PoolRepeatRuleConfig).warn}
						disabled={!!writeSettingsDenied}
						onCheckedChange={(checked) => setWarn(checked === true)}
					/>
				</div>
			)}
			<div className="contents">
				<PermissionDeniedTooltip denied={writeSettingsDenied}>
					<Button
						size="icon"
						variant="outline"
						onClick={deleteRule}
						disabled={!!writeSettingsDenied}
						className="h-8 w-8"
					>
						<Icons.Minus className="h-4 w-4" />
					</Button>
				</PermissionDeniedTooltip>
			</div>
		</>
	)
}

function PoolRepeatRulesConfigurationPanel(props: {
	className?: string
	poolId: 'mainPool' | 'generationPool'
	stores: SquadServerFrame.KeyProp
}) {
	const stores = props.stores
	const rulesPath = React.useMemo(() => SETTINGS.SettingsPathSchema.parse(['queue', props.poolId, 'repeatRules']), [props.poolId])
	const selectRulesLength = React.useCallback(
		(s: ServerSettingsPrt.Store) => (SETTINGS.derefSettingsValue(s.settings.edited, rulesPath) as LQY.RepeatRule[]).length,
		[rulesPath],
	)

	const writeSettingsDenied = RbacClient.usePermsCheck(RBAC.perm('settings:write'))
	const rulesLength = ZusUtils.useStore(stores.squadServer!, selectRulesLength)

	const addRule = React.useCallback(() => {
		const edited = ZusUtils.getState(stores.squadServer!).settings.edited
		const rules = SETTINGS.derefSettingsValue(edited, rulesPath) as LQY.RepeatRule[]
		const updated = Im.produce(rules, (draft) => {
			draft.push({
				field: 'Map',
				within: 0,
				label: 'Map',
			})
		})
		ServerSettingsPrt.Actions.set({ settings: stores.squadServer! }, { path: rulesPath, value: updated })
	}, [rulesPath, stores.squadServer])

	const showWarn = props.poolId === 'mainPool'
	const applyMainPoolRepeatRulesSwitchId = React.useId()
	const applyMainPoolRepeatRules = ZusUtils.useStore(
		stores.squadServer!,
		(s) => s.settings.edited.queue.generationPool.applyMainPoolRepeatRules,
	)
	const setApplyMainPoolRepeatRules = (checked: boolean | 'indeterminate') => {
		if (checked === 'indeterminate') return
		ServerSettingsPrt.Actions.set({ settings: stores.squadServer! }, {
			path: ['queue', 'generationPool', 'applyMainPoolRepeatRules'],
			value: checked,
		})
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
					{props.poolId === 'generationPool' && (
						<span className="flex items-center gap-1 text-sm text-muted-foreground">
							<Label htmlFor={applyMainPoolRepeatRulesSwitchId} className="font-normal cursor-pointer">
								Also apply main pool repeat rules
							</Label>
							<PermissionDeniedTooltip denied={writeSettingsDenied}>
								<Switch
									id={applyMainPoolRepeatRulesSwitchId}
									disabled={!!writeSettingsDenied}
									checked={applyMainPoolRepeatRules}
									onCheckedChange={setApplyMainPoolRepeatRules}
								/>
							</PermissionDeniedTooltip>
						</span>
					)}
					<PermissionDeniedTooltip denied={writeSettingsDenied}>
						<Button
							size="sm"
							variant="outline"
							disabled={!!writeSettingsDenied}
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
					{/* Rules */}
					{Array.from({ length: rulesLength }, (_, index) => (
						<RepeatRuleRow
							key={index}
							index={index}
							poolId={props.poolId}
							stores={stores}
						/>
					))}
				</div>
			</div>
		</div>
	)
}
