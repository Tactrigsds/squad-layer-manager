import * as Icons from 'lucide-react'
import React from 'react'

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
import * as SquadServerFrame from '@/frames/squad-server.frame.ts'
import * as MapUtils from '@/lib/map-utils'
import * as Obj from '@/lib/object-utils'
import { cn } from '@/lib/utils.ts'
import * as Zus from '@/lib/zustand'
import * as LL_Msgs from '@/messages/layer-list.messages'
import * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models.ts'
import type * as SETTINGS from '@/models/settings.models'
import * as UP from '@/models/user-presence'
import * as RBAC from '@/rbac.models.ts'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import * as LayerQueriesClient from '@/systems/layer-queries.client'
import * as LQYClient from '@/systems/layer-queries.client.ts'
import * as LayerQueueClient from '@/systems/layer-queue.client'
import * as RbacClient from '@/systems/rbac.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as UPClient from '@/systems/user-presence.client'
import * as UsersClient from '@/systems/users.client'

import { RepeatViolationDisplay } from './constraint-matches-indicator.tsx'
import { LayerList } from './layer-list.tsx'
import { useOpenPoolConfigWindow } from './pool-config-window.helpers.ts'
import ShortLayerName from './short-layer-name.tsx'

void import('@/components/pool-config-window')

import { assertNever } from '@/lib/type-guards.ts'
import { tr } from '@/systems/messages.client'

import EmojiDisplay from './emoji-display.tsx'
import { FilterEntityLink } from './filter-entity-select.tsx'
import { StickyGroup } from './sticky-group.tsx'

function ValidationWarningsDisplay(props: {
	showWarnings: boolean
	warnings: LQY.QueueWarning[] | null
	setShowWarnings: (showWarnings: boolean) => void
	stores: SquadServerFrame.KeyProp
}) {
	const constraints = LayerQueriesClient.useLayerItemStatusConstraints(props.stores.squadServer)
	const layerList = Zus.useStore(props.stores.squadServer!, (s) => s.queue.layerList)
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
					<AlertTitle>{tr.text(LL_Msgs.repeatsDetected())}</AlertTitle>
					<AlertDescription>
						{tr.text(LL_Msgs.repeatsBlurb())}
						<div className="flex flex-col gap-1">
							{repeatWarnings.map((warning) => {
								const { item, index, parity, descriptors } = warning
								const onMouseOver = () => {
									LQYClient.Actions.setHoveredConstraintItemId(item.itemId ?? null)
								}
								const onMouseOut = () => {
									const state = Zus.getState(LQYClient.Store)
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
										{descriptors.map((descriptor) => {
											const constraint = constraints.find(
												(c) => descriptor.constraintId === c.id && c.type === 'do-not-repeat',
											) as Extract<LQY.Constraint, { type: 'do-not-repeat' }>
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
					<AlertTitle>{tr.text(LL_Msgs.filterWarnings())}</AlertTitle>
					<AlertDescription>
						{tr.text(LL_Msgs.filterWarningsBlurb())}
						<div className="flex flex-col gap-1">
							{[...filterWarnings.values()].map((warnings) => {
								const { item, index, parity } = warnings[0]
								const onMouseOver = () => {
									LQYClient.Actions.setHoveredConstraintItemId(item.itemId ?? null)
								}
								const onMouseOut = () => {
									const state = Zus.getState(LQYClient.Store)
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
											const constraint = constraints.find((c) => c.id === warning.constraintId)
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
	const loggedInUser = UsersClient.useLoggedInUser()
	return Zus.useStore(stores.squadServer!, SquadServerFrame.Sel.queueWarnings(loggedInUser?.discordId))
}

// type QueueErrorWithDetails =
type QueueControlPanelProps = {
	warnings: LQY.QueueWarning[] | null
	showWarnings: boolean
	setShowWarnings: (showWarnings: boolean) => void
	stores: SquadServerFrame.KeyProp
}

function QueueControlPanel(props: QueueControlPanelProps) {
	const { showWarnings, setShowWarnings } = props
	const loggedInUser = UsersClient.useLoggedInUser()
	// const isEditing = UPClient.useIsEditing()
	const [isEditing, setIsEditing] = UPClient.useEditingQueueState(props.stores.squadServer!.serverId)
	const numEditors = Zus.useStore(UPClient.Store, (state) => state.editors.size)
	const [forceSave, setForceSave] = React.useState(false)
	const openPoolConfig = useOpenPoolConfigWindow({ stores: { squadServer: props.stores.squadServer! } })

	const setEditing = async (editing: boolean) => {
		if (editing) {
			setIsEditing(true)
			setShowWarnings(false)
		} else {
			// statuses lag an edit by a debounce plus a query, so the warnings in this closure can belong to a queue the
			// user has already edited away from. Gating on those both blocks a save that shouldn't be blocked and drops
			// the acknowledgement when the real statuses land.
			await SquadServerFrame.awaitCurrentStatuses(props.stores.squadServer!)
			const currentWarnings = SquadServerFrame.Sel.queueWarnings(loggedInUser?.discordId)(Zus.getState(props.stores.squadServer!))
			if (currentWarnings && !showWarnings && !forceSave) {
				setShowWarnings(true)
				return
			}
			// clears queue editing across all of this user's clients via the presence reducer fan-out
			setIsEditing(false)
			setForceSave(false)
			setShowWarnings(false)
			const editorCount = Zus.getState(UPClient.Store).editors.size
			const isModified = Zus.getState(props.stores.squadServer!).queue.isModified

			if (isModified && (editorCount === 0 || forceSave)) {
				await LayerQueuePrt.Actions.dispatch({ queue: props.stores.squadServer! }, { op: 'save', force: forceSave })
			}
		}
	}

	const [isModified, committing] = Zus.useStore(
		props.stores.squadServer!,
		Zus.useShallow((s) => [s.queue.isModified, s.queue.committing]),
	)
	const startEditingDenied = RbacClient.usePermsCheck(RBAC.perm('queue:write', { serverId: props.stores.squadServer!.serverId }))

	function clear() {
		const state = Zus.getState(props.stores.squadServer!)
		// we don't have to include children here
		const itemIds = state.queue.layerList.map((item) => item.itemId)
		void LayerQueuePrt.Actions.dispatch({ queue: props.stores.squadServer! }, { op: 'clear', itemIds })
	}

	return (
		<div className="flex flex-col gap-1 grow">
			<div className="flex items-center gap-1 justify-end group" data-status={committing ? 'saving' : !isEditing ? 'idle' : 'editing'}>
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
						<p>{tr.text(LL_Msgs.clearQueue())}</p>
					</TooltipContent>
				</Tooltip>
				<StartActivityInteraction
					loaderName="selectLayers"
					createActivity={UP.createEditingQueueVariant({
						_tag: 'leaf',
						id: 'ADDING_ITEM',
						opts: { cursor: { type: 'start' }, variant: 'toggle-position', action: 'add' },
					})}
					matchKey={(key) => key.id === 'ADDING_ITEM' && key.opts.variant === 'toggle-position'}
					preload="intent"
					render={Button}
					className="flex w-min items-center space-x-0 not-group-data-[status=editing]:invisible"
					variant="secondary"
					disabled={!isEditing}
				>
					<Icons.ListPlus />
					<span>{tr.text(LL_Msgs.addLayers())}</span>
				</StartActivityInteraction>
				<StartActivityInteraction
					loaderName="genVote"
					createActivity={UP.createEditingQueueVariant({
						_tag: 'leaf',
						id: 'GENERATING_VOTE',
						opts: { cursor: { type: 'start' } },
					})}
					matchKey={(key) => key.id === 'GENERATING_VOTE'}
					preload="intent"
					render={Button}
					className="flex w-min items-center space-x-0 not-group-data-[status=editing]:invisible"
					variant="secondary"
					disabled={!isEditing}
				>
					<Icons.Vote />
					{tr.text(LL_Msgs.genVote())}
				</StartActivityInteraction>
				<StartActivityInteraction
					loaderName="pasteRotation"
					createActivity={UP.createEditingQueueVariant({ _tag: 'leaf', id: 'PASTE_ROTATION', opts: {} })}
					matchKey={(key) => key.id === 'PASTE_ROTATION'}
					preload="intent"
					render={Button}
					className="flex w-min items-center space-x-0 not-group-data-[status=editing]:invisible"
					variant="secondary"
					disabled={!isEditing}
				>
					<Icons.FileText />
					<span>{tr.text(LL_Msgs.pasteRotationTitle())}</span>
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
						<p>{tr.text(LL_Msgs.reset())}</p>
					</TooltipContent>
				</Tooltip>
				{/*<Separator orientation="vertical" />*/}
				<div className="grid">
					<div className="col-start-2 row-start-1 flex items-center gap-2 invisible group-data-[status=saving]:visible">
						<Icons.LoaderCircle className="animate-spin h-4 w-4" />
						<span className="text-sm">{tr.text(LL_Msgs.saving())}</span>
					</div>
					<PermissionDeniedTooltip denied={startEditingDenied}>
						<Button
							className="col-start-2 row-start-1 invisible group-data-[status=idle]:visible"
							variant="outline"
							disabled={!!startEditingDenied}
							onClick={() => setEditing(true)}
						>
							<Icons.Edit />
							<span>{tr.text(LL_Msgs.startEditing())}</span>
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
											// icon-only, so it needs a name of its own: the tooltip is not one
											aria-label={tr.text(LL_Msgs.toggleForceSave())}
											aria-pressed={forceSave}
											onClick={() => setForceSave(!forceSave)}
										>
											<Icons.Sword />
										</Button>
									</TooltipTrigger>
									<TooltipContent>
										<p>{tr.text(LL_Msgs.toggleForceSaveHint())}</p>
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
													: numEditors === 1 && isModified
														? showWarnings
															? 'Save Anyway'
															: 'Save'
														: showWarnings
															? 'Finish Editing Anyway'
															: 'Finish Editing'}
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
				<Button
					size="icon"
					variant="ghost"
					title={tr.text(LL_Msgs.poolConfiguration())}
					onClick={(e) => openPoolConfig(e.currentTarget)}
				>
					<Icons.Settings />
				</Button>
			</div>
		</div>
	)
}

export function QueuePanelContent(props: { className?: string; stores: SquadServerFrame.KeyProp }) {
	const {
		isModified,
		queueLength,
		maxQueueSize,
		mutations: queueMutations,
	} = Zus.useStore(props.stores.squadServer!, SquadServerFrame.Sel.queueHeader)
	const headerRef = React.useRef<HTMLDivElement>(null)

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
			<CardHeader ref={headerRef} className={cn('flex flex-row items-center justify-between bg-background', props.className)}>
				<span className="flex items-center space-x-1 w-full">
					<span className="flex flex-col gap-0.5">
						<span className="flex items-center space-x-1">
							<CardTitle>{tr.text(LL_Msgs.upNext())}</CardTitle>
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
			<StickyGroup stickyRef={headerRef}>
				<CardContent className="p-0 px-1">
					<LayerList stores={props.stores} />
				</CardContent>
			</StickyGroup>
		</>
	)
}

// Why SLM stopped writing the rotation, always shown alongside the fact that it did. `by` is null on settings
// written before the reason recorded who acted.
function DisabledReason(props: { reason: SETTINGS.SlmUpdatesDisabled }) {
	const by = props.reason.type === 'manual' ? props.reason.by : null
	const user = UsersClient.useResolvedUser(by?.type === 'slm-user' ? by.userId : undefined)
	if (props.reason.type === 'ingame-vote') {
		// never state the deduction as fact: SLM saw the next layer go missing, not the vote itself
		return props.reason.inferred ? <>{tr.text(LL_Msgs.disabledByInferredVote())}</> : <>{tr.text(LL_Msgs.disabledByIngameVote())}</>
	}
	switch (by?.type) {
		case 'slm-user':
			return <span>{user?.displayName ?? tr.text(LL_Msgs.disabledByUnnamedUser())}</span>
		case 'ingame-user':
			return <>{tr.text(LL_Msgs.disabledByIngameAdmin())}</>
		case 'system':
			return <>{tr.text(LL_Msgs.disabledBySlm())}</>
		case undefined:
			return <>{tr.text(LL_Msgs.disabledByUnrecorded())}</>
		default:
			assertNever(by)
	}
}

// What the Squad server's own vote is doing. Purely informational: it says nothing about SLM's own state, which
// SlmUpdatesDisabledAlert owns. `choices` is whichever stage of the vote is open now, so it is layers during the
// map stage and factions during the faction stages.
export function IngameVoteAlert(props: { stores: SquadServerFrame.KeyProp }) {
	const ingameVote = LayerQueueClient.useIngameVote(props.stores.squadServer!.serverId)
	if (!ingameVote) return null

	return (
		<Alert variant="warning">
			<AlertTitle>{tr.text(LL_Msgs.inGameVoteRunning())}</AlertTitle>
			<AlertDescription>
				{tr.text(LL_Msgs.inGameVoteBlurb())}
				{ingameVote.choices.length > 0 && <> {tr.text(LL_Msgs.currentlyVotingBetween(ingameVote.choices.join(', ')))}</>}
			</AlertDescription>
		</Alert>
	)
}

export function SlmUpdatesDisabledAlert(props: { stores: SquadServerFrame.KeyProp }) {
	const serverId = props.stores.squadServer!.serverId
	const statusRes = SquadServerClient.useLayersStatus(serverId)
	const nextLayer = statusRes.code === 'ok' ? statusRes.data.nextLayer : null
	const updatesDisabled = Zus.useStore(props.stores.squadServer!, (s) => s.settings.saved.updatesToSquadServerDisabled)
	const { enableUpdates } = LayerQueueClient.useToggleSquadServerUpdates(serverId)
	const enableUpdatesDenied = RbacClient.usePermsCheck(
		RBAC.perm('squad-server:disable-slm-updates', { serverId: props.stores.squadServer!.serverId }),
	)
	if (!updatesDisabled) return null

	return (
		<Alert variant="destructive">
			<AlertTitle>{tr.text(LL_Msgs.slmUpdatesDisabled())}</AlertTitle>
			<AlertDescription>
				{tr.text(LL_Msgs.slmUpdatesDisabledBy())} <DisabledReason reason={updatesDisabled} />.{' '}
				{/* during a vote the server's next layer is whatever the vote last wrote, so reporting it as the next layer
				    would be stating something that is still being decided */}
				{nextLayer && updatesDisabled.type !== 'ingame-vote' && (
					<>
						{tr.text(LL_Msgs.currentNextLayerIs())} <ShortLayerName layerId={nextLayer.id} />.
					</>
				)}{' '}
				<br />{' '}
				<PermissionDeniedTooltip denied={enableUpdatesDenied} triggerClassName="mr-1 inline-block">
					<Button disabled={!!enableUpdatesDenied} variant="secondary" onClick={() => enableUpdates()}>
						{tr.text(LL_Msgs.clickHere())}
					</Button>
				</PermissionDeniedTooltip>
				{tr.text(LL_Msgs.enableUpdatesCta(updatesDisabled.type === 'ingame-vote'))}
			</AlertDescription>
		</Alert>
	)
}
