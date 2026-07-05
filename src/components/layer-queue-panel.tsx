import { StartActivityInteraction } from '@/components/activity.tsx'
import { PermissionDeniedTooltip } from '@/components/permission-denied-tooltip'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { CardDescription } from '@/components/ui/card'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import * as LayerQueuePrt from '@/frame-partials/layer-queue.partial'
import type * as SquadServerFrame from '@/frames/squad-server.frame.ts'
import * as MapUtils from '@/lib/map'
import * as Obj from '@/lib/object'
import * as ODSM from '@/lib/odsm'
import { cn } from '@/lib/utils.ts'

import * as ZusUtils from '@/lib/zustand'
import * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models.ts'

import * as SLL from '@/models/shared-layer-list'
import * as UP from '@/models/user-presence'
import * as RBAC from '@/rbac.models.ts'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import * as LayerQueriesClient from '@/systems/layer-queries.client'
import * as LQYClient from '@/systems/layer-queries.client.ts'
import * as LayerQueueClient from '@/systems/layer-queue.client'
import * as RbacClient from '@/systems/rbac.client'
import * as SettingsClient from '@/systems/settings.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as UPClient from '@/systems/user-presence.client'
import * as UsersClient from '@/systems/users.client'
import * as Icons from 'lucide-react'
import React from 'react'
import { RepeatViolationDisplay } from './constraint-matches-indicator.tsx'
import { LayerList } from './layer-list.tsx'
import PoolConfigurationPopover from './server-settings-popover.tsx'
import ShortLayerName from './short-layer-name.tsx'

import { assertNever } from '@/lib/type-guards.ts'
import EmojiDisplay from './emoji-display.tsx'
import { FilterEntityLink } from './filter-entity-select.tsx'

function ValidationWarningsDisplay(
	props: {
		showWarnings: boolean
		warnings: LQY.QueueWarning[] | null
		setShowWarnings: (showWarnings: boolean) => void
		stores: SquadServerFrame.KeyProp
	},
) {
	const constraints = LayerQueriesClient.useLayerItemStatusConstraints(props.stores.squadServer)
	const layerList = ZusUtils.useStore(props.stores.squadServer!, s => s.queue.layerList)
	const itemsState = LayerQueueClient.useLayerItemsState(props.stores.squadServer!.serverId)
	const filters = FilterEntityClient.useFilterEntities()
	if (!props.showWarnings || !props.warnings || props.warnings.length === 0) return null

	type QueueWarning = LQY.QueueWarning & { parity: number; item: LL.Item; index: LL.ItemIndex }

	const repeatWarnings: Extract<QueueWarning, { type: 'repeat-rule-violation-warning' }>[] = []
	const filterWarnings: Map<string, Extract<QueueWarning, { type: 'filter-entity-warning' }>[]> = new Map()

	if (props.warnings) {
		for (const warning of props.warnings) {
			if (!LQY.isLayerListItemId(warning.itemId)) continue
			const { item, index } = Obj.destrNullable(LL.findItemById(layerList, warning.itemId))
			if (!item) {
				console.warn(`No item found for warning itemId: ${warning.itemId}`)
				continue
			}
			const parity = LQY.getParityForLayerItem(itemsState, warning.itemId)

			if (warning.type === 'filter-entity-warning') {
				const itemFilterWarnings = MapUtils.defaultInsGet(filterWarnings, warning.itemId, [])
				itemFilterWarnings.push({ ...warning, item, index, parity })
			} else if (warning.type === 'repeat-rule-violation-warning') repeatWarnings.push({ ...warning, item, index, parity })
			else assertNever(warning)
		}
	}

	return (
		<>
			{repeatWarnings.length > 0 && (
				<Alert variant="repeat-violation" className="mx-4 my-2 w-auto">
					<Icons.AlertTriangle className="h-4 w-4" />
					<AlertTitle>Repeats Detected</AlertTitle>
					<AlertDescription>
						The following queued layers have repeated elements that violate our configured rules:
						<div className="flex flex-col gap-1">
							{repeatWarnings.map((warning) => {
								const { item, index, parity, descriptors } = warning
								const onMouseOver = () => {
									LQYClient.Actions.setHoveredConstraintItemId(item.itemId ?? null)
								}
								const onMouseOut = () => {
									const state = ZusUtils.getState(LQYClient.Store)
									if (state.hoveredConstraintItemId !== item.itemId) return
									LQYClient.Actions.setHoveredConstraintItemId(null)
								}
								return (
									<div
										key={item.itemId}
										className="flex items-center gap-2 text-sm hover:bg-secondary"
										onMouseOver={onMouseOver}
										onMouseOut={onMouseOut}
									>
										<span className="font-mono text-muted-foreground">{LL.getItemNumber(index)}</span>
										<ShortLayerName layerId={item.layerId} teamParity={parity} matchDescriptors={descriptors} />
										{descriptors.map(descriptor => {
											const constraint = constraints.find(c => descriptor.constraintId === c.id && c.type === 'do-not-repeat') as Extract<
												LQY.Constraint,
												{ type: 'do-not-repeat' }
											>
											if (!constraint) return null
											return (
												<RepeatViolationDisplay
													showIcon={false}
													key={`${item.itemId}-${descriptor.constraintId}-${descriptor.field}${descriptor.repeatOffset}`}
													constraint={constraint}
													itemParity={parity}
												/>
											)
										})}
									</div>
								)
							})}
						</div>
					</AlertDescription>
				</Alert>
			)}
			{filterWarnings.size > 0 && (
				<Alert variant="warning" className="mx-4 my-2 w-auto">
					<Icons.AlertTriangle className="h-4 w-4" />
					<AlertTitle>Filter Warnings</AlertTitle>
					<AlertDescription>
						The following queued layers triggered filter warnings:
						<div className="flex flex-col gap-1">
							{[...filterWarnings.values()].map((warnings) => {
								const { item, index, parity } = warnings[0]
								const onMouseOver = () => {
									LQYClient.Actions.setHoveredConstraintItemId(item.itemId ?? null)
								}
								const onMouseOut = () => {
									const state = ZusUtils.getState(LQYClient.Store)
									if (state.hoveredConstraintItemId !== item.itemId) return
									LQYClient.Actions.setHoveredConstraintItemId(null)
								}
								return (
									<div
										key={item.itemId}
										className="flex items-center gap-2 text-sm hover:bg-secondary"
										onMouseOver={onMouseOver}
										onMouseOut={onMouseOut}
									>
										<span className="font-mono text-muted-foreground">{LL.getItemNumber(index)}</span>
										<ShortLayerName layerId={item.layerId} teamParity={parity} />
										{warnings.map((warning) => {
											const constraint = constraints.find(c => c.id === warning.constraintId)
											if (!constraint || constraint.type !== 'filter-entity') return null
											const filter = filters.get(constraint.filterId)
											if (!filter) return null
											let emoji: string | undefined | null
											let alertMessage: string | undefined | null
											if (warning.matched) {
												emoji = filter.emoji
												alertMessage = filter.alertMessage
											} else if (filter.invertedEmoji && filter.invertedAlertMessage) {
												emoji = filter.invertedEmoji
												alertMessage = filter.invertedAlertMessage
											}
											return (
												<span key={constraint.id} className="text-muted-foreground flex flex-nowrap items-center gap-1">
													{emoji && <EmojiDisplay showTooltip={false} emoji={emoji} />}
													{alertMessage && <span>{alertMessage}</span>}
													<FilterEntityLink filterId={filter.id} />
												</span>
											)
										})}
									</div>
								)
							})}
						</div>
					</AlertDescription>
				</Alert>
			)}
		</>
	)
}

function useQueueWarnings(stores: SquadServerFrame.KeyProp) {
	const warns = ZusUtils.useStore(stores.squadServer, s => s.layerItemStatuses?.warns)
	const loggedInUser = UsersClient.useLoggedInUser()
	const queueModifiedByUser = ZusUtils.useStore(
		stores.squadServer!,
		s =>
			s.queue.isModified && !!loggedInUser && SLL.hasUserMutations(
				ODSM.Client.localOps(s.queue.rbSession),
				s.queue.rbSession.localState,
				loggedInUser.discordId,
			),
	)

	return React.useMemo(() => {
		if (!warns || !queueModifiedByUser) return null
		return warns
	}, [
		warns,
		queueModifiedByUser,
	])
}

// type QueueErrorWithDetails =
type QueueControlPanelProps = {
	warnings: LQY.QueueWarning[] | null
	showWarnings: boolean
	setShowWarnings: (showWarnings: boolean) => void
	stores: SquadServerFrame.KeyProp
}

function QueueControlPanel(props: QueueControlPanelProps) {
	const { warnings, showWarnings, setShowWarnings } = props
	// const isEditing = UPClient.useIsEditing()
	const [isEditing, setIsEditing] = UPClient.useEditingQueueState(props.stores.squadServer!.serverId)
	const numEditors = ZusUtils.useStore(UPClient.Store, state => state.editors.size)
	const [forceSave, setForceSave] = React.useState(false)

	const setEditing = async (editing: boolean) => {
		if (editing) {
			setIsEditing(true)
			setShowWarnings(false)
		} else {
			if (warnings && !showWarnings && !forceSave) {
				setShowWarnings(true)
				return
			}
			setIsEditing(false)
			setForceSave(false)
			setShowWarnings(false)
			const editorCount = ZusUtils.getState(UPClient.Store).editors.size
			const isModified = ZusUtils.getState(props.stores.squadServer!).queue.isModified

			if (isModified && (editorCount === 0 || forceSave)) {
				await LayerQueuePrt.Actions.dispatch({ queue: props.stores.squadServer! }, { op: 'save' })
			}
		}
	}

	const [isModified, committing] = ZusUtils.useStore(
		props.stores.squadServer!,
		ZusUtils.useShallow(s => [s.queue.isModified, s.queue.committing]),
	)
	const startEditingDenied = RbacClient.usePermsCheck(RBAC.perm('queue:write'))

	function clear() {
		const state = ZusUtils.getState(props.stores.squadServer!)
		// we don't have to include children here
		const itemIds = state.queue.layerList.map(item => item.itemId)
		void LayerQueuePrt.Actions.dispatch({ queue: props.stores.squadServer! }, { op: 'clear', itemIds })
	}

	return (
		<div className="flex flex-col gap-1 grow">
			<div
				className="flex items-center gap-1 justify-end group"
				data-status={committing
					? 'saving'
					: !isEditing
					? 'idle'
					: 'editing'}
			>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							disabled={!isEditing}
							className="not-group-data-[status=editing]:invisible"
							variant="secondary"
							size="icon"
							onClick={() => clear()}
						>
							<Icons.Trash />
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						<p>Clear Queue</p>
					</TooltipContent>
				</Tooltip>
				<StartActivityInteraction
					loaderName="selectLayers"
					createActivity={UP.createEditingQueueVariant({
						_tag: 'leaf',
						id: 'ADDING_ITEM',
						opts: { cursor: { type: 'start' }, variant: 'toggle-position', action: 'add' },
					})}
					matchKey={key => key.id === 'ADDING_ITEM' && key.opts.variant === 'toggle-position'}
					preload="intent"
					render={Button}
					className="flex w-min items-center space-x-0 not-group-data-[status=editing]:invisible"
					variant="secondary"
					disabled={!isEditing}
				>
					<Icons.PlusIcon />
					<span>Add Layers</span>
				</StartActivityInteraction>
				<StartActivityInteraction
					loaderName="genVote"
					createActivity={UP.createEditingQueueVariant({ _tag: 'leaf', id: 'GENERATING_VOTE', opts: { cursor: { type: 'start' } } })}
					matchKey={key => key.id === 'GENERATING_VOTE'}
					preload="intent"
					render={Button}
					className="flex w-min items-center space-x-0 not-group-data-[status=editing]:invisible"
					variant="secondary"
					disabled={!isEditing}
				>
					<Icons.Vote />Gen Vote
				</StartActivityInteraction>
				<StartActivityInteraction
					loaderName="pasteRotation"
					createActivity={UP.createEditingQueueVariant({ _tag: 'leaf', id: 'PASTE_ROTATION', opts: {} })}
					matchKey={key => key.id === 'PASTE_ROTATION'}
					preload="intent"
					render={Button}
					className="flex w-min items-center space-x-0 not-group-data-[status=editing]:invisible"
					variant="secondary"
					disabled={!isEditing}
				>
					<Icons.FileText />
					<span>Paste Rotation</span>
				</StartActivityInteraction>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							size="icon"
							disabled={!isModified}
							onClick={() => LayerQueuePrt.Actions.dispatch({ queue: props.stores.squadServer! }, { op: 'reset-to-saved' })}
							variant="secondary"
							className="col-start-1 row-start-1 not-group-data-[status=editing]:invisible"
						>
							<Icons.Undo />
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						<p>Reset</p>
					</TooltipContent>
				</Tooltip>
				{/*<Separator orientation="vertical" />*/}
				<div className="grid">
					<div className="col-start-2 row-start-1 flex items-center gap-2 invisible group-data-[status=saving]:visible">
						<Icons.LoaderCircle className="animate-spin h-4 w-4" />
						<span className="text-sm">Saving...</span>
					</div>
					<PermissionDeniedTooltip
						denied={startEditingDenied}
					>
						<Button
							className="col-start-2 row-start-1 invisible group-data-[status=idle]:visible"
							variant="outline"
							disabled={!!startEditingDenied}
							onClick={() => setEditing(true)}
						>
							<Icons.Edit />
							<span>Start Editing</span>
						</Button>
					</PermissionDeniedTooltip>
					{(() => {
						const saveButtonGroup = (
							<ButtonGroup>
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											size="icon"
											variant={forceSave ? 'destructive' : 'secondary'}
											onClick={() => setForceSave(!forceSave)}
										>
											<Icons.Sword />
										</Button>
									</TooltipTrigger>
									<TooltipContent>
										<p>Toggle Force save (Save even if others are still editing)</p>
									</TooltipContent>
								</Tooltip>
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											className="min-w-37.5"
											variant={forceSave ? 'destructive' : 'default'}
											onClick={() => setEditing(false)}
										>
											<Icons.Save />
											<span>
												{forceSave
													? 'Force Save'
													: (numEditors === 1 && isModified)
													? (showWarnings ? 'Save Anyway' : 'Save')
													: (showWarnings ? 'Finish Editing Anyway' : 'Finish Editing')}
											</span>
										</Button>
									</TooltipTrigger>
									<TooltipContent>
										<p>
											{forceSave
												? 'Save changes, even if others are still editing'
												: isModified
												? 'Save changes to the queue'
												: 'Finish editing the queue'}
										</p>
									</TooltipContent>
								</Tooltip>
							</ButtonGroup>
						)
						return <div className="col-start-2 row-start-1 invisible group-data-[status=editing]:visible">{saveButtonGroup}</div>
					})()}
				</div>
				<PoolConfigurationPopover stores={{ squadServer: props.stores.squadServer! }}>
					<Button size="icon" variant="ghost" title="Pool Configuration">
						<Icons.Settings />
					</Button>
				</PoolConfigurationPopover>
			</div>
		</div>
	)
}

export function QueuePanelContent(props: { className?: string; stores: SquadServerFrame.KeyProp }) {
	const isModified = ZusUtils.useStore(props.stores.squadServer!, s => s.queue.isModified)

	const queueLength = ZusUtils.useStore(props.stores.squadServer!, (s) => s.queue.layerList.length)
	const maxQueueSize = ZusUtils.useStore(SettingsClient.PublicSettingsStore)?.layerQueue.maxQueueSize
	const queueMutations = ZusUtils.useStore(props.stores.squadServer!, (s) => s.queue.mutations)

	const warnings = useQueueWarnings(props.stores)
	const [showWarnings, setShowWarnings] = React.useState(false)
	React.useEffect(() => {
		if (!warnings) {
			setShowWarnings(false)
		}
	}, [warnings])

	return (
		<>
			<ValidationWarningsDisplay
				warnings={warnings ?? []}
				showWarnings={showWarnings}
				setShowWarnings={setShowWarnings}
				stores={props.stores}
			/>
			<CardHeader className={cn('flex flex-row items-center justify-between', props.className)}>
				<span className="flex items-center space-x-1 w-full">
					<span className="flex flex-col gap-0.5">
						<span className="flex items-center space-x-1">
							<CardTitle>Up Next</CardTitle>
							{isModified && (
								<CardDescription
									data-limitreached={queueLength >= (maxQueueSize ?? Infinity)}
									className=" pl-1 data-[limitreached=true]:text-destructive flex gap-1 items-center"
								>
									<span>
										{queueLength} / {maxQueueSize}
									</span>
								</CardDescription>
							)}
						</span>
						<span className="flex gap-1">
							{[
								{ variant: 'added', size: queueMutations.added.size, label: 'added', icon: Icons.Plus },
								{ variant: 'edited', size: queueMutations.edited.size, label: 'edited', icon: Icons.Pencil },
								{ variant: 'moved', size: queueMutations.moved.size, label: 'moved', icon: Icons.ArrowUpDown },
								{ variant: 'destructive', size: queueMutations.removed.size, label: 'removed', icon: Icons.Trash },
							]
								.sort((a, b) => (b.size > 0 ? 1 : 0) - (a.size > 0 ? 1 : 0))
								.map((item) => (
									<Badge
										key={item.label}
										variant={item.variant as 'added' | 'edited' | 'moved' | 'destructive'}
										data-visible={item.size > 0}
										className="data-[visible=false]:invisible font-mono font-semibold tracking-tight flex items-center gap-1"
										title={`${item.size} ${item.label}`}
									>
										<item.icon className="h-3 w-3" />
										{item.size}
									</Badge>
								))}
						</span>
					</span>
					<QueueControlPanel
						warnings={warnings ?? null}
						showWarnings={showWarnings}
						setShowWarnings={setShowWarnings}
						stores={props.stores}
					/>
				</span>
			</CardHeader>
			<CardContent className="p-0 px-1">
				<LayerList stores={props.stores} />
			</CardContent>
		</>
	)
}

export function SlmUpdatesDisabledAlert(props: { stores: SquadServerFrame.KeyProp }) {
	const serverId = props.stores.squadServer!.serverId
	const statusRes = SquadServerClient.useLayersStatus(serverId)
	const nextLayer = statusRes.code === 'ok' ? statusRes.data.nextLayer : null
	const updatesDisabled = ZusUtils.useStore(props.stores.squadServer!, s => s.settings.saved.updatesToSquadServerDisabled)
	const { enableUpdates } = LayerQueueClient.useToggleSquadServerUpdates(serverId)
	const enableUpdatesDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:disable-slm-updates'))
	if (!updatesDisabled) return null

	return (
		<Alert variant="destructive">
			<AlertTitle>SLM Updates Disabled</AlertTitle>
			<AlertDescription>
				SLM is not currently syncing the queue to the squad server. {nextLayer && (
					<>
						Current next layer on the server is <ShortLayerName layerId={nextLayer.id} />.
					</>
				)} <br />{' '}
				<PermissionDeniedTooltip denied={enableUpdatesDenied} triggerClassName="mr-1 inline-block">
					<Button disabled={!!enableUpdatesDenied} variant="secondary" onClick={() => enableUpdates()}>Click Here</Button>
				</PermissionDeniedTooltip>
				to enable SLM Updates.
			</AlertDescription>
		</Alert>
	)
}
