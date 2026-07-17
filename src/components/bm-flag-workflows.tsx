import { BmFlagMultiSelect, FlagLabel } from '@/components/bm-flag-picker'
import { toast } from '@/lib/toast'
import * as ZusUtils from '@/lib/zustand'
import * as BM from '@/models/battlemetrics.models'
import * as RPC from '@/orpc.client'
import * as RBAC from '@/rbac.models'
import * as BattlemetricsClient from '@/systems/battlemetrics.client'
import * as RbacClient from '@/systems/rbac.client'
import * as SettingsClient from '@/systems/settings.client'
import { useMutation } from '@tanstack/react-query'
import * as Icons from 'lucide-react'
import React from 'react'
import { PermissionDeniedTooltip } from './permission-denied-tooltip'
import type { MenuSlots } from './player-context-menu-options'
import { Button } from './ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { useAlertDialog } from './ui/lazy-alert-dialog'

// Flags carry no per-player payload, so "managing" them is really two unrelated jobs: adding a flag (which is a
// judgement call that may need justifying) and taking one back off. A single diffing multi-select made both look like
// one edit and gave the reason nowhere to live, so they're split.

function ReasonField(props: {
	reasonRef: React.MutableRefObject<string>
	required: boolean
	placeholder: string
	// flags driving the requirement, named so the admin knows which selection to undo if they don't want to explain it
	requiredBy?: string[]
}) {
	return (
		<div className="grid gap-2">
			<Label>
				Reason
				{props.required
					? <span className="text-destructive">{' '}(required)</span>
					: <span className="text-muted-foreground">{' '}(optional)</span>}
			</Label>
			<Input
				autoComplete="off"
				placeholder={props.placeholder}
				defaultValue={props.reasonRef.current}
				onChange={(e) => {
					props.reasonRef.current = e.target.value
				}}
			/>
			{props.required && props.requiredBy && props.requiredBy.length > 0 && (
				<span className="text-xs text-muted-foreground">
					Required by {props.requiredBy.join(', ')}
				</span>
			)}
			<span className="text-xs text-muted-foreground">
				Posted to the player's BattleMetrics profile as a note.
			</span>
		</div>
	)
}

export function AddFlagsDialogContent(props: {
	currentFlagIds: string[]
	flagIdsRef: React.MutableRefObject<string[]>
	reasonRef: React.MutableRefObject<string>
}) {
	const orgFlags = BattlemetricsClient.useOrgFlags()
	const requiringNote = ZusUtils.useStore(SettingsClient.PublicSettingsStore, (s) => s?.playerFlagsRequiringNote ?? [])
	// mirrored into state so the reason field can flip to required as the selection changes
	const [selected, setSelected] = React.useState<string[]>(() => props.flagIdsRef.current)

	// a flag the player already has isn't addable; the manage workflow is where those live
	const addable = (orgFlags ?? []).map((f) => f.id).filter((id) => !props.currentFlagIds.includes(id))
	const requiredBy = BM.resolveFlags(BM.flagsRequiringNote(selected, requiringNote), orgFlags ?? []).map((f) => f.name)

	if (addable.length === 0) {
		return <p className="text-xs text-muted-foreground">This player already has every flag configured for the organization.</p>
	}

	return (
		<div className="grid gap-4">
			<div className="grid gap-2">
				<Label>Flags to add</Label>
				<BmFlagMultiSelect
					value={selected}
					only={addable}
					placeholder="Select flags to add..."
					onChange={(next) => {
						setSelected(next)
						props.flagIdsRef.current = next
					}}
				/>
			</div>
			<ReasonField
				reasonRef={props.reasonRef}
				required={requiredBy.length > 0}
				requiredBy={requiredBy}
				placeholder="Why are these flags being applied?"
			/>
		</div>
	)
}

export function RemoveFlagsDialogContent(props: {
	currentFlagIds: string[]
	flagIdsRef: React.MutableRefObject<string[]>
	reasonRef: React.MutableRefObject<string>
}) {
	const orgFlags = BattlemetricsClient.useOrgFlags()
	// staged rather than removed on click: one confirm means one BM note covering the whole change, and a misclick on a
	// destructive action stays undoable while the dialog is open
	const [staged, setStaged] = React.useState<string[]>(() => props.flagIdsRef.current)

	function toggle(id: string) {
		const next = staged.includes(id) ? staged.filter((f) => f !== id) : [...staged, id]
		setStaged(next)
		props.flagIdsRef.current = next
	}

	if (props.currentFlagIds.length === 0) {
		return <p className="text-xs text-muted-foreground">This player has no flags.</p>
	}

	return (
		<div className="grid gap-4">
			<div className="grid gap-2">
				<Label>Current flags</Label>
				<ul className="grid gap-1">
					{props.currentFlagIds.map((id) => {
						const isStaged = staged.includes(id)
						return (
							<li key={id} className="flex items-center justify-between gap-2 rounded border px-2 py-1">
								<span className={isStaged ? 'opacity-40 line-through' : undefined}>
									<FlagLabel id={id} flags={orgFlags} />
								</span>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="h-6 px-1"
									title={isStaged ? 'Keep this flag' : 'Remove this flag'}
									onClick={() => toggle(id)}
								>
									{isStaged ? <Icons.Undo2 className="h-3 w-3" /> : <Icons.X className="h-3 w-3 text-destructive" />}
								</Button>
							</li>
						)
					})}
				</ul>
			</div>
			<ReasonField reasonRef={props.reasonRef} required={false} placeholder="Why are these flags being removed?" />
		</div>
	)
}

// the two workflows as bare menu items, so the context menu and the details window can each wrap them in their own
// chrome (a submenu / a dropdown) without duplicating the dialog plumbing
export function PlayerFlagsMenuItems(props: {
	Item: MenuSlots['Item']
	playerId: string
}) {
	const Item = props.Item
	const openDialog = useAlertDialog()
	const currentFlagIds = BattlemetricsClient.usePlayerFlagIds(props.playerId)
	const orgFlags = BattlemetricsClient.useOrgFlags()
	const addMutation = useMutation(RPC.orpc.battlemetrics.addFlags.mutationOptions())
	const removeMutation = useMutation(RPC.orpc.battlemetrics.removeFlags.mutationOptions())
	const flagIdsRef = React.useRef<string[]>([])
	const reasonRef = React.useRef('')

	function flagNames(ids: string[]) {
		return BM.resolveFlags(ids, orgFlags ?? []).map((f) => f.name).join(', ')
	}

	async function addFlags() {
		if (currentFlagIds === null) return
		flagIdsRef.current = []
		reasonRef.current = ''
		const result = await openDialog({
			title: 'Add Flags',
			description: "Add BattleMetrics flags to this player's profile.",
			content: <AddFlagsDialogContent currentFlagIds={currentFlagIds} flagIdsRef={flagIdsRef} reasonRef={reasonRef} />,
			buttons: [{ id: 'confirm', label: 'Add Flags' }],
		})
		if (result !== 'confirm') return
		const flagIds = flagIdsRef.current
		if (flagIds.length === 0) {
			toast.error('No flags selected')
			return
		}
		const res = await addMutation.mutateAsync({ playerId: props.playerId, flagIds, reason: reasonRef.current.trim() || undefined })
		if (res.code === 'err:reason-required') {
			toast.error('Reason required', { description: `These flags require a reason: ${res.flags.join(', ')}` })
			return
		}
		if (res.code !== 'ok') {
			toast.error('Failed to add flags', { description: res.code })
			return
		}
		toast(`Added ${flagNames(flagIds)}`, {
			description: res.noteAdded ? undefined : 'The flags were added, but the BattleMetrics note failed to post.',
		})
	}

	async function manageFlags() {
		if (currentFlagIds === null) return
		flagIdsRef.current = []
		reasonRef.current = ''
		const result = await openDialog({
			title: 'Manage Flags',
			description: "Remove BattleMetrics flags from this player's profile.",
			variant: 'destructive',
			content: <RemoveFlagsDialogContent currentFlagIds={currentFlagIds} flagIdsRef={flagIdsRef} reasonRef={reasonRef} />,
			buttons: [{ id: 'confirm', label: 'Remove Flags' }],
		})
		if (result !== 'confirm') return
		const flagIds = flagIdsRef.current
		if (flagIds.length === 0) {
			toast.error('No flags marked for removal')
			return
		}
		const removedNames = flagNames(flagIds)
		const res = await removeMutation.mutateAsync({
			playerId: props.playerId,
			flagIds,
			reason: reasonRef.current.trim() || undefined,
		})
		if (res.code !== 'ok') {
			toast.error('Failed to remove flags', { description: res.code })
			return
		}
		toast(`Removed ${removedNames}`, {
			description: res.noteAdded ? undefined : 'The flags were removed, but the BattleMetrics note failed to post.',
		})
	}

	return (
		<>
			<Item onClick={addFlags} disabled={currentFlagIds === null}>Add Flags...</Item>
			<Item onClick={manageFlags} disabled={!currentFlagIds || currentFlagIds.length === 0}>Manage Flags...</Item>
		</>
	)
}

// the Flags context-menu entry: Add and Manage, each opening its own workflow
export function PlayerFlagsSub(props: { slots: MenuSlots; playerId: string; label?: string }) {
	const { Item, Sub, SubTrigger, SubContent } = props.slots
	const denied = RbacClient.usePermsCheck(RBAC.perm('battlemetrics:write-flags'))
	return (
		<PermissionDeniedTooltip denied={denied}>
			<Sub>
				<SubTrigger disabled={!!denied}>{props.label ?? 'Flags'}</SubTrigger>
				<SubContent>
					<PlayerFlagsMenuItems Item={Item} playerId={props.playerId} />
				</SubContent>
			</Sub>
		</PermissionDeniedTooltip>
	)
}

// the player-details-window entry point: the same two workflows behind the flag row's edit affordance
export function PlayerFlagsDropdown(props: { playerId: string }) {
	const denied = RbacClient.usePermsCheck(RBAC.perm('battlemetrics:write-flags'))
	return (
		<PermissionDeniedTooltip denied={denied}>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						disabled={!!denied}
						className="inline-flex items-center rounded p-0.5 text-muted-foreground hover:text-foreground transition-colors shrink-0 disabled:opacity-50 disabled:pointer-events-none"
						title="Edit flags"
					>
						<Icons.Pencil className="h-3 w-3" />
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start">
					<PlayerFlagsMenuItems Item={DropdownMenuItem} playerId={props.playerId} />
				</DropdownMenuContent>
			</DropdownMenu>
		</PermissionDeniedTooltip>
	)
}
