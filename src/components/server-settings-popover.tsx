import { PermissionDeniedTooltip } from '@/components/permission-denied-tooltip'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useDebounced } from '@/hooks/use-debounce.ts'
import * as Arr from '@/lib/array'
import { assertNever } from '@/lib/type-guards.ts'
import * as Typography from '@/lib/typography.ts'
import { cn } from '@/lib/utils.ts'
import { devValidate } from '@/lib/zod.dev.ts'
import type * as F from '@/models/filter.models.ts'
import * as L from '@/models/layer'
import * as LQY from '@/models/layer-queries.models.ts'
import * as SS from '@/models/server-state.models.ts'
import * as UP from '@/models/user-presence'
import * as RBAC from '@/rbac.models'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import * as RbacClient from '@/systems/rbac.client'
import * as ServerSettingsClient from '@/systems/server-settings.client'
import * as UPClient from '@/systems/user-presence.client'
import * as Im from 'immer'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'
import { useShallow } from 'zustand/react/shallow'
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
	reset(settings: SS.ServerSettings): void
}

export default function ServerSettingsPopover(
	props: {
		children: React.ReactNode
		ref?: React.ForwardedRef<ServerSettingsPopoverHandle>
	},
) {
	React.useImperativeHandle(props.ref, () => ({
		reset: () => {},
	}))

	const [poolId, setPoolId] = React.useState<'mainPool' | 'generationPool'>('mainPool')

	const [open, _setOpen] = UPClient.useActivityState(UP.VIEWING_SETTINGS_TRANSITIONS)
	const setOpen = (open: boolean) => {
		if (!open) {
			void ServerSettingsClient.Store.getState().reset()
		}
		_setOpen(open)
	}

	const [settingsChanged, saving, validationErrors] = Zus.useStore(
		ServerSettingsClient.Store,
		useShallow(s => [s.modified, s.saving, s.validationErrors]),
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
										void ServerSettingsClient.Store.getState().reset()
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
						? <PoolFiltersConfigurationPanel />
						: <GenerationPoolFiltersPanel />}
					<PoolRepeatRulesConfigurationPanel
						className={poolId !== 'mainPool' ? 'hidden' : undefined}
						poolId="mainPool"
					/>
					<PoolRepeatRulesConfigurationPanel
						className={poolId !== 'generationPool' ? 'hidden' : undefined}
						poolId="generationPool"
					/>
				</div>
				<div className="flex justify-end gap-2 pt-4 border-t">
					<div className="flex flex-col gap-2">
						{validationErrors && validationErrors.map((error, index) => (
							<Alert key={error + index} variant="destructive">
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
							const saved = await ServerSettingsClient.Store.getState().save()
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

function PoolFiltersConfigurationPanel() {
	const filtersPath = ['queue', 'mainPool', 'filters']
	const filterConfigs = Zus.useStore(
		ServerSettingsClient.Store,
		(s) => SS.derefSettingsValue(s.edited, filtersPath) as SS.PoolFilterConfig[],
	)
	const filterEntities = FilterEntityClient.useFilterEntities()

	const writeSettingsDenied = RbacClient.usePermsCheck(RBAC.perm('settings:write'))

	const add = (filterId: F.FilterEntityId | null) => {
		if (filterId === null) return
		const state = ServerSettingsClient.Store.getState()
		const newFilters: SS.PoolFilterConfig[] = [...filterConfigs, {
			filterId,
			defaultApplyDuringLayerSelection: SS.DEFAULT_POOL_FILTER_APPLY_AS,
		}]
		state.set({ path: filtersPath, value: newFilters })
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
							const state = ServerSettingsClient.Store.getState()
							const newValue: SS.PoolFilterConfig = {
								filterId: newFilterId,
								defaultApplyDuringLayerSelection: SS.DEFAULT_POOL_FILTER_APPLY_AS,
							}
							state.set({ path: filterPath, value: newValue })
						}
						const deleteFilter = () => {
							const state = ServerSettingsClient.Store.getState()
							const filterConfigs = SS.derefSettingsValue(state.edited, filtersPath) as SS.PoolFilterConfig[]
							state.set({ path: filtersPath, value: filterConfigs.filter((c) => c.filterId !== filterConfig.filterId) })
						}
						const excludedFilterIds = filterConfigs.flatMap((c) => filterId !== c.filterId ? [c.filterId] : [])
						const defaultApplyDescriptions: { [k in SS.PoolFilterDefaultApplyAsSetting]: string } = {
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
						const warnDescriptions: { [k in SS.PoolFilterApplyAs]: string } = {
							regular: 'Warn when a layer matching this filter is queued or about to be played',
							inverted: 'Warn when a layer NOT matching this filter is queued or about to be played',
							disabled: 'No warning',
						}
						const canWarn = !!filterConfig.showIndicator && filterConfig.showIndicator !== 'disabled'
						const handleIndicateMatchesChanged = (_newValue: LQY.IndicatorState | undefined) => {
							const newValue = _newValue ?? 'disabled'
							const state = ServerSettingsClient.Store.getState()
							const newConfig: SS.PoolFilterConfig = {
								...filterConfig,
								showIndicator: newValue,
								warn: newValue === 'disabled' ? undefined : filterConfig.warn,
							}
							state.set({ path: filterPath, value: newConfig })
						}
						const handleDefaultApplyChanged = (_newValue: SS.PoolFilterDefaultApplyAsSetting | undefined) => {
							const newValue = _newValue ?? 'disabled'
							const state = ServerSettingsClient.Store.getState()
							state.set({ path: [...filterPath, 'defaultApplyDuringLayerSelection'], value: newValue })
						}
						const handleWarnChanged = (newWarn: SS.PoolFilterApplyAs) => {
							const state = ServerSettingsClient.Store.getState()
							state.set({ path: [...filterPath, 'warn'], value: newWarn })
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
									options={SS.POOL_FILTER_DEFAULT_APPLY_AS_SETTING.options.map(v => ({ value: v, label: defaultApplyDescriptions[v] }))}
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

function GenerationPoolFiltersPanel() {
	const filtersPath = ['queue', 'generationPool', 'filters']
	const filterConfigs = Zus.useStore(
		ServerSettingsClient.Store,
		(s) => SS.derefSettingsValue(s.edited, filtersPath) as SS.GenerationFilterConfig[],
	)
	const filterEntities = FilterEntityClient.useFilterEntities()
	const writeSettingsDenied = RbacClient.usePermsCheck(RBAC.perm('settings:write'))

	const add = (filterId: F.FilterEntityId | null) => {
		if (filterId === null) return
		const state = ServerSettingsClient.Store.getState()
		const newFilters: SS.GenerationFilterConfig[] = [...filterConfigs, { filterId, applyAs: 'regular' }]
		state.set({ path: filtersPath, value: newFilters })
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
							const state = ServerSettingsClient.Store.getState()
							state.set({ path: filterPath, value: { filterId: newFilterId, applyAs: filterConfig.applyAs } })
						}
						const deleteFilter = () => {
							const state = ServerSettingsClient.Store.getState()
							const configs = SS.derefSettingsValue(state.edited, filtersPath) as SS.GenerationFilterConfig[]
							state.set({ path: filtersPath, value: configs.filter((c) => c.filterId !== filterId) })
						}
						const handleApplyAsChanged = (newValue: SS.PoolFilterApplyAs) => {
							const state = ServerSettingsClient.Store.getState()
							state.set({ path: [...filterPath, 'applyAs'], value: newValue })
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
}) {
	const { index, poolId } = props

	const paths = React.useMemo(() => {
		const rules = devValidate(SS.SettingsPathSchema, ['queue', poolId, 'repeatRules'])
		const rule = devValidate(SS.SettingsPathSchema, [...rules, index])
		return {
			rules,
			rule,
			label: devValidate(SS.SettingsPathSchema, [...rule, 'label']),
			field: devValidate(SS.SettingsPathSchema, [...rule, 'field']),
			within: devValidate(SS.SettingsPathSchema, [...rule, 'within']),
			targetValues: devValidate(SS.SettingsPathSchema, [...rule, 'targetValues']),
			warn: devValidate(SS.SettingsPathSchema, [...rule, 'warn']),
		}
	}, [poolId, index])

	const selectRuleConfig = React.useCallback(
		(s: ServerSettingsClient.EditSettingsStore) => {
			return (SS.derefSettingsValue(s.edited, paths.rules) as SS.PoolRepeatRuleConfig[])[index]
		},
		[paths.rules, index],
	)

	const writeSettingsDenied = RbacClient.usePermsCheck(RBAC.perm('settings:write'))
	const rule = Zus.useStore(ServerSettingsClient.Store, selectRuleConfig)

	const writeLabel = React.useCallback((label: string) => {
		const state = ServerSettingsClient.Store.getState()
		state.set({ path: paths.label, value: label })
	}, [paths.label])

	const setLabel = useDebounced({
		onChange: writeLabel,
		delay: 250,
	})

	const setField = (field: LQY.RepeatRuleField) => {
		const state = ServerSettingsClient.Store.getState()
		state.set({ path: paths.field, value: field })
		state.set({ path: paths.label, value: field })
	}

	const writeWithin = React.useCallback((within: number) => {
		const state = ServerSettingsClient.Store.getState()
		state.set({ path: paths.within, value: within })
	}, [paths.within])

	const setWithin = useDebounced({
		onChange: writeWithin,
		delay: 250,
	})

	const setTargetValues = (update: React.SetStateAction<string[]>) => {
		const state = ServerSettingsClient.Store.getState()
		const originalValues = SS.derefSettingsValue(state.edited, paths.targetValues) as string[] | undefined
		const targetValues = typeof update === 'function' ? update(originalValues ?? []) : update
		state.set({ path: paths.targetValues, value: targetValues.length === 0 ? undefined : targetValues })
	}

	const setWarn = (warn: boolean) => {
		const state = ServerSettingsClient.Store.getState()
		state.set({ path: paths.warn, value: warn || undefined })
	}

	const deleteRule = () => {
		const state = ServerSettingsClient.Store.getState()
		const rules = SS.derefSettingsValue(state.edited, paths.rules) as LQY.RepeatRule[]
		const updated = Im.produce(rules, (draft) => {
			draft.splice(index, 1)
		})
		state.set({ path: paths.rules, value: updated })
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
						checked={!!(rule as SS.PoolRepeatRuleConfig).warn}
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
}) {
	const rulesPath = React.useMemo(() => SS.SettingsPathSchema.parse(['queue', props.poolId, 'repeatRules']), [props.poolId])
	const selectRulesLength = React.useCallback(
		(s: ServerSettingsClient.EditSettingsStore) => (SS.derefSettingsValue(s.edited, rulesPath) as LQY.RepeatRule[]).length,
		[rulesPath],
	)

	const writeSettingsDenied = RbacClient.usePermsCheck(RBAC.perm('settings:write'))
	const rulesLength = Zus.useStore(ServerSettingsClient.Store, selectRulesLength)

	const addRule = React.useCallback(() => {
		const state = ServerSettingsClient.Store.getState()
		const rules = SS.derefSettingsValue(state.edited, rulesPath) as LQY.RepeatRule[]
		const updated = Im.produce(rules, (draft) => {
			draft.push({
				field: 'Map',
				within: 0,
				label: 'Map',
			})
		})
		state.set({ path: rulesPath, value: updated })
	}, [rulesPath])

	const showWarn = props.poolId === 'mainPool'
	const applyMainPoolRepeatRulesSwitchId = React.useId()
	const applyMainPoolRepeatRules = Zus.useStore(
		ServerSettingsClient.Store,
		(s) => s.edited.queue.generationPool.applyMainPoolRepeatRules,
	)
	const setApplyMainPoolRepeatRules = (checked: boolean | 'indeterminate') => {
		if (checked === 'indeterminate') return
		ServerSettingsClient.Store.getState().set({ path: ['queue', 'generationPool', 'applyMainPoolRepeatRules'], value: checked })
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
						/>
					))}
				</div>
			</div>
		</div>
	)
}
