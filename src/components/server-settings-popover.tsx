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
import type * as SLL from '@/models/shared-layer-list'
import * as RBAC from '@/rbac.models'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import * as ServerSettingsClient from '@/systems/server-settings.client'
import * as SLLClient from '@/systems/shared-layer-list.client'
import { useLoggedInUser } from '@/systems/users.client'
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
	const user = useLoggedInUser()
	const canWriteSettings = user && RBAC.rbacUserHasPerms(user, RBAC.perm('settings:write'))

	React.useImperativeHandle(props.ref, () => ({
		reset: () => {},
	}))

	const [poolId, setPoolId] = React.useState<'mainPool' | 'generationPool'>('mainPool')

	const [open, _setOpen] = SLLClient.useActivityState({
		matchActivity: React.useCallback((activity) => !!activity.child.VIEWING_SETTINGS, []),
		createActivity: Im.produce((draft: Im.WritableDraft<SLL.RootActivity>) => {
			draft.child.VIEWING_SETTINGS = {
				_tag: 'branch',
				id: 'VIEWING_SETTINGS',
				opts: {},
				child: {},
			}
		}),
		removeActivity: Im.produce((draft: Im.WritableDraft<SLL.RootActivity>) => {
			delete draft.child.VIEWING_SETTINGS
		}),
	})
	const setOpen = (open: boolean) => {
		if (!open) {
			void ServerSettingsClient.Store.getState().reset()
		}
		_setOpen(open)
	}

	const [applyMainPool, settingsChanged, saving, validationErrors] = Zus.useStore(
		ServerSettingsClient.Store,
		useShallow(s => [s.edited.queue.applyMainPoolToGenerationPool, s.modified, s.saving, s.validationErrors]),
	)
	const applymainPoolSwitchId = React.useId()

	function setApplyMainPool(checked: boolean | 'indeterminate') {
		if (checked === 'indeterminate') return
		ServerSettingsClient.Store.getState().set({ path: ['queue', 'applyMainPoolToGenerationPool'], value: checked })
	}

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>{props.children}</PopoverTrigger>
			<PopoverContent
				className="w-[800px] flex flex-col space-y-4 p-6"
				side="left"
				align="start"
			>
				<div className="flex items-center justify-between border-b pb-3">
					<h3 className="text-lg font-semibold">Pool Configuration</h3>
					<div className="flex items-center space-x-2">
						<div className={cn('flex items-center space-x-1', poolId === 'generationPool' ? '' : 'invisible')}>
							<Label htmlFor={applymainPoolSwitchId}>Apply Main Pool</Label>
							<Switch
								disabled={!canWriteSettings}
								id={applymainPoolSwitchId}
								checked={applyMainPool}
								onCheckedChange={setApplyMainPool}
							/>
						</div>
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
					<PoolFiltersConfigurationPanel poolId={poolId} />
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
						className="min-w-[120px]"
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

function PoolFiltersConfigurationPanel({
	poolId,
}: {
	poolId: 'mainPool' | 'generationPool'
}) {
	const filtersPath = ['queue', poolId, 'filters']
	const filterConfigs = Zus.useStore(
		ServerSettingsClient.Store,
		(s) => SS.derefSettingsValue(s.edited, filtersPath) as SS.PoolFilterConfig[],
	)
	const filterEntities = FilterEntityClient.useFilterEntities()

	const user = useLoggedInUser()
	const canWriteSettings = user && RBAC.rbacUserHasPerms(user, RBAC.perm('settings:write'))

	const add = (filterId: F.FilterEntityId | null) => {
		if (filterId === null) return
		const state = ServerSettingsClient.Store.getState()
		const newFilters: SS.PoolFilterConfig[] = [...filterConfigs, { filterId, applyAs: SS.DEFAULT_POOL_FILTER_APPLY_AS }]
		state.set({ path: filtersPath, value: newFilters })
	}

	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between">
				<span className="flex items-center gap-2">
					<h4 className={cn(Typography.H4, 'text-sm font-medium text-muted-foreground')}>Filters:</h4>
				</span>
				<FilterEntitySelect
					title="New Pool Filter"
					filterId={null}
					onSelect={add}
					excludedFilterIds={Arr.deref('filterId', filterConfigs)}
					allowEmpty={false}
					enabled={canWriteSettings ?? false}
				>
					<Button disabled={!canWriteSettings} size="sm" variant="outline">
						<Icons.Plus className="h-4 w-4 mr-2" />
						Add Filter
					</Button>
				</FilterEntitySelect>
			</div>
			<div className="space-y-2">
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
						const newValue: SS.PoolFilterConfig = { filterId: newFilterId, applyAs: SS.DEFAULT_POOL_FILTER_APPLY_AS }
						state.set({ path: filterPath, value: newValue })
					}
					const deleteFilter = () => {
						const state = ServerSettingsClient.Store.getState()
						const filterConfigs = SS.derefSettingsValue(state.edited, filtersPath) as SS.PoolFilterConfig[]
						state.set({ path: filtersPath, value: filterConfigs.filter((c) => c.filterId !== filterConfig.filterId) })
					}

					const excludedFilterIds = filterConfigs.flatMap((c) => filterId !== c.filterId ? [c.filterId] : [])

					const descriptions: { [k in SS.ConstraintApplyAs]: string } = {
						regular: 'When selecting layers, filter is applied by default',
						inverted: 'When selecting layers, filter is applied and inverted by default',
						disabled: 'When selecting layers, filter is disabled by default',
					}

					const handleApplyAsChanged = (newApplyAs: SS.ConstraintApplyAs) => {
						const state = ServerSettingsClient.Store.getState()
						state.set({ path: [...filterPath, 'applyAs'], value: newApplyAs })
					}

					return (
						<div className="flex items-center space-x-2 bg-card" key={filterId}>
							<FilterEntitySelect
								enabled={canWriteSettings ?? false}
								className="grow"
								title="Pool Filter"
								filterId={filterId}
								onSelect={onSelect}
								allowToggle={false}
								allowEmpty={false}
								excludedFilterIds={excludedFilterIds}
							/>
							<TriStateCheckbox
								checked={filterConfig.applyAs}
								onCheckedChange={handleApplyAsChanged}
								title={descriptions[filterConfig.applyAs]}
							/>
							<Button
								disabled={!canWriteSettings}
								size="icon"
								variant="outline"
								onClick={() => deleteFilter()}
							>
								<Icons.Minus className="h-4 w-4" />
							</Button>
						</div>
					)
				})}
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
		}
	}, [poolId, index])

	const selectRule = React.useCallback(
		(s: ServerSettingsClient.EditSettingsStore) => {
			return (SS.derefSettingsValue(s.edited, paths.rules) as LQY.RepeatRule[])[index]
		},
		[paths.rules, index],
	)

	const user = useLoggedInUser()
	const canWriteSettings = user && RBAC.rbacUserHasPerms(user, RBAC.perm('settings:write'))
	const rule = Zus.useStore(ServerSettingsClient.Store, selectRule)

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
					disabled={!canWriteSettings}
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
					disabled={!canWriteSettings}
				/>
			</div>
			<div className="contents">
				<Input
					type="number"
					defaultValue={rule.within}
					disabled={!canWriteSettings}
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
					disabled={!canWriteSettings}
					values={rule.targetValues ?? []}
					onSelect={(updated) => {
						setTargetValues(updated)
					}}
				/>
			</div>
			<div className="contents">
				<Button
					size="icon"
					variant="outline"
					onClick={deleteRule}
					disabled={!canWriteSettings}
					className="h-8 w-8"
				>
					<Icons.Minus className="h-4 w-4" />
				</Button>
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

	const user = useLoggedInUser()
	const canWriteSettings = user && RBAC.rbacUserHasPerms(user, RBAC.perm('settings:write'))
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

	return (
		<div className={cn('space-y-3', props.className)}>
			<div className="flex items-center justify-between">
				<span className="flex items-center gap-2">
					<h4 className={cn(Typography.H4, 'text-sm font-medium text-muted-foreground')}>
						Repeat Rules
					</h4>
					<ConstraintViolationIcon />
				</span>
				<Button
					size="sm"
					variant="outline"
					disabled={!canWriteSettings}
					onClick={addRule}
				>
					<Icons.Plus className="h-4 w-4 mr-2" />
					Add Repeat Rule
				</Button>
			</div>
			<div className="border rounded-md p-3">
				<div
					className="grid gap-2 items-center"
					style={{ gridTemplateColumns: '2fr 2fr 60px 4fr max-content' }}
				>
					{/* Header Row */}
					<div className="contents text-sm font-medium text-muted-foreground">
						<div>Label</div>
						<div>Field</div>
						<div>Within</div>
						<div>Target Values</div>
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
