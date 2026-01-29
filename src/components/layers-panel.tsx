import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { CardDescription } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'

import * as ItemMut from '@/lib/item-mutations'
import * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models.ts'
import * as SLL from '@/models/shared-layer-list'
import * as ConfigClient from '@/systems/config.client'
import * as LayerQueriesClient from '@/systems/layer-queries.client'
import * as LQYClient from '@/systems/layer-queries.client.ts'
import * as QD from '@/systems/queue-dashboard.client'
import * as SLLClient from '@/systems/shared-layer-list.client'
import * as UsersClient from '@/systems/users.client.ts'

import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { RepeatViolationDisplay } from './constraint-matches-indicator.tsx'
import { LayerList, StartActivityInteraction } from './layer-list.tsx'
import { MatchHistoryPanelContent } from './match-history-panel'
import PoolConfigurationPopover from './server-settings-popover.tsx'
import ShortLayerName from './short-layer-name.tsx'

import UserPresencePanel from './user-presence-panel.tsx'

export default function LayersPanel() {
	return (
		<Card className="flex flex-col flex-1 min-h-0">
			<ScrollArea className="flex-1">
				<MatchHistoryPanelContent />
				<Separator />
				<CardHeader className="flex flex-row items-center justify-between">
					<CardTitle>Recent Users</CardTitle>
					<UserPresencePanel />
				</CardHeader>
				<Separator />
				<QueuePanelContent />
			</ScrollArea>
		</Card>
	)
}

type QueueError = {
	item: LL.Item
	index: LL.ItemIndex
	descriptors: LQY.RepeatMatchDescriptor[]
	parity: number
}

function ValidationErrorsDisplay(
	props: {
		showErrors: boolean
		errors: QueueError[] | null
		setShowErrors: (showErrors: boolean) => void
	},
) {
	const constraints = LayerQueriesClient.useLayerItemStatusConstraints()
	if (!props.showErrors || !props.errors || props.errors.length === 0) return null

	return (
		<Alert variant="repeat-violation" className="mx-4 my-2 w-auto">
			<Icons.AlertTriangle className="h-4 w-4" />
			<AlertTitle>Repeats Detected</AlertTitle>
			<AlertDescription>
				The following layers from your edits have repeated elements that violate our configured rules:
				<div className="flex flex-col gap-1">
					{props.errors.map(({ item, index, descriptors, parity }) => {
						const onMouseOver = () => {
							LQYClient.Store.getState().setHoveredConstraintItemId(item.itemId ?? null)
						}
						const onMouseOut = () => {
							const state = LQYClient.Store.getState()
							if (state.hoveredConstraintItemId !== item.itemId) return
							state.setHoveredConstraintItemId(null)
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
										<RepeatViolationDisplay showIcon={false} key={descriptor.constraintId} constraint={constraint} itemParity={parity} />
									)
								})}
							</div>
						)
					})}
				</div>
			</AlertDescription>
		</Alert>
	)
}

function useQueueErrors() {
	const constraints = LayerQueriesClient.useLayerItemStatusConstraints()
	const statuses = LayerQueriesClient.useLayerItemStatuses(constraints)?.data
	const session = Zus.useStore(SLLClient.Store, s => s.session)
	const loggedInUser = UsersClient.useLoggedInUser()
	const layerItemsState = QD.useLayerItemsState()

	return React.useMemo(() => {
		if (!loggedInUser?.discordId) return null
		const errors: QueueError[] = []
		for (const { item, index } of LL.iterItems(session.list)) {
			if (!ItemMut.idMutated(session.mutations, item.itemId)) continue
			if (item.source.type !== 'manual' || item.source.userId !== loggedInUser.discordId) continue
			const descriptors = statuses?.matchDescriptors.get(item.itemId)
			if (!descriptors) continue
			const relevantDescriptors: LQY.RepeatMatchDescriptor[] = []
			for (const descriptor of descriptors) {
				if (descriptor.type === 'repeat-rule') {
					relevantDescriptors.push(descriptor)
				}
			}
			const parity = LQY.getParityForLayerItem(layerItemsState, item.itemId)
			errors.push({ item, index, descriptors: relevantDescriptors, parity })
		}
		return errors
	}, [session.list, session.mutations, loggedInUser?.discordId, statuses?.matchDescriptors, layerItemsState])
}

type QueueControlPanelProps = {
	errors: QueueError[] | null
	showErrors: boolean
	setShowErrors: (showErrors: boolean) => void
}

function QueueControlPanel(props: QueueControlPanelProps) {
	const { errors, showErrors, setShowErrors } = props
	const isEditing = SLLClient.useIsEditing()
	const [forceSave, setForceSave] = React.useState(false)

	const setEditing = async (editing: boolean) => {
		if (editing) {
			setShowErrors(false)
			void SLLClient.Store.getState().dispatch({ op: 'start-editing' })
		} else {
			if (errors && !showErrors && !forceSave) {
				setShowErrors(true)
				return
			}
			void SLLClient.Store.getState().dispatch({ op: 'finish-editing', forceSave: forceSave || undefined })
			setForceSave(false)
			setShowErrors(false)
		}
	}

	const [isModified, committing, numEditors] = Zus.useStore(
		SLLClient.Store,
		useShallow(s => [s.isModified, s.committing, s.session.editors.size]),
	)

	function clear() {
		const state = QD.LQStore.getState()
		// we don't have to include children here
		const itemIds = state.layerList.map(item => item.itemId)
		void state.dispatch({ op: 'clear', itemIds })
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
							variant="outline"
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
					createActivity={SLL.createEditActivityVariant({
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
					createActivity={SLL.createEditActivityVariant({ _tag: 'leaf', id: 'GENERATING_VOTE', opts: { cursor: { type: 'start' } } })}
					matchKey={key => key.id === 'GENERATING_VOTE'}
					preload="intent"
					render={Button}
					className="flex w-min items-center space-x-0 not-group-data-[status=editing]:invisible"
					variant="secondary"
					disabled={!isEditing}
				>
					<Icons.Vote />Gen Vote
				</StartActivityInteraction>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							size="icon"
							disabled={!isModified}
							onClick={() => SLLClient.Store.getState().reset()}
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
					<Button
						variant="outline"
						onClick={() => setEditing(true)}
						className="col-start-2 row-start-1 invisible group-data-[status=idle]:visible"
					>
						<Icons.Edit />
						<span>Start Editing</span>
					</Button>
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
										<p>Toggle Force save (Save even if others are stil )</p>
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
													? (showErrors ? 'Save Anyway' : 'Save')
													: (showErrors ? 'Finish Editing Anyway' : 'Finish Editing')}
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
				<PoolConfigurationPopover>
					<Button size="icon" variant="ghost" title="Pool Configuration">
						<Icons.Settings />
					</Button>
				</PoolConfigurationPopover>
			</div>
		</div>
	)
}

export function QueuePanelContent() {
	const isModified = Zus.useStore(SLLClient.Store, s => s.isModified)

	const queueLength = Zus.useStore(QD.LQStore, (s) => s.layerList.length)
	const maxQueueSize = ConfigClient.useConfig()?.layerQueue.maxQueueSize
	const queueMutations = Zus.useStore(QD.LQStore, (s) => s.session.mutations)

	const errors = useQueueErrors()
	const [showErrors, setShowErrors] = React.useState(false)
	React.useEffect(() => {
		if (!errors) {
			setShowErrors(false)
		}
	}, [errors])

	return (
		<>
			<ValidationErrorsDisplay errors={errors ?? []} showErrors={showErrors} setShowErrors={setShowErrors} />
			<CardHeader className="flex flex-row items-center justify-between">
				<span className="flex items-center space-x-1 w-full">
					<span className="flex flex-col gap-0.5">
						<span className="flex items-center space-x-1">
							<CardTitle>Up Next</CardTitle>
							{
								/*<Toggle
							pressed={isEditing}
							onPressedChange={setEditing}
							aria-label="Toggle bookmark"
							size="sm"
						>
							{isEditing
								? (
									<>
										<Icons.Check className="ml-1" />
										<span>Finished</span>
									</>
								)
								: (
									<>
										<Icons.Edit className="ml-1" />
										<span>Start Editing</span>
									</>
								)}
						</Toggle>*/
							}
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
					<QueueControlPanel errors={errors} showErrors={showErrors} setShowErrors={setShowErrors} />
				</span>
			</CardHeader>
			<CardContent className="p-0 px-1">
				<LayerList store={SLLClient.Store} />
			</CardContent>
		</>
	)
}
