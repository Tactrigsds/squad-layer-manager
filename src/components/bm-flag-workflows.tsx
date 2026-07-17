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

// One reason per flag, because each flag's note carries only its own: a shared box would put the same text against
// flags applied for unrelated reasons. Rows appear as flags are picked, so a dialog with nothing selected has no
// inputs at all. Keyed by flag id, so adding or dropping a row leaves the others' typed text alone.
function FlagReasonRows(props: {
	flagIds: string[]
	reasonsRef: React.MutableRefObject<Record<string, string>>
	// flag ids that can't be submitted without a reason; empty when nothing is required (removals)
	requiringNote: string[]
	orgFlags: BM.PlayerFlag[] | undefined
	placeholder: string
}) {
	if (props.flagIds.length === 0) return null
	return (
		<div className="grid gap-3">
			{props.flagIds.map((id) => {
				const required = props.requiringNote.includes(id)
				return (
					<div key={id} className="grid gap-1">
						<Label className="flex items-center gap-1">
							<FlagLabel id={id} flags={props.orgFlags} />
							{required
								? <span className="text-xs text-destructive">(reason required)</span>
								: <span className="text-xs text-muted-foreground">(reason optional)</span>}
						</Label>
						<Input
							autoComplete="off"
							placeholder={props.placeholder}
							defaultValue={props.reasonsRef.current[id] ?? ''}
							onChange={(e) => {
								props.reasonsRef.current[id] = e.target.value
							}}
						/>
					</div>
				)
			})}
			<span className="text-xs text-muted-foreground">
				Each reason is posted to the player's BattleMetrics profile as its own note.
			</span>
		</div>
	)
}

// only the flags still selected: a row's text survives in the ref after its flag is dropped, so it can be restored if
// the flag is picked again, but it must never be submitted for a flag that isn't being changed
function readFlagChanges(flagIds: string[], reasonsRef: React.MutableRefObject<Record<string, string>>): BM.FlagChange[] {
	return flagIds.map((id) => ({ id, reason: reasonsRef.current[id]?.trim() || undefined }))
}

export function AddFlagsDialogContent(props: {
	currentFlagIds: string[]
	flagIdsRef: React.MutableRefObject<string[]>
	reasonsRef: React.MutableRefObject<Record<string, string>>
}) {
	const orgFlags = BattlemetricsClient.useOrgFlags()
	const requiringNote = ZusUtils.useStore(SettingsClient.PublicSettingsStore, (s) => s?.playerFlagsRequiringNote ?? [])
	// mirrored into state so the reason rows follow the selection
	const [selected, setSelected] = React.useState<string[]>(() => props.flagIdsRef.current)

	// a flag the player already has isn't addable; the remove workflow is where those live
	const addable = (orgFlags ?? []).map((f) => f.id).filter((id) => !props.currentFlagIds.includes(id))

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
			<FlagReasonRows
				flagIds={selected}
				reasonsRef={props.reasonsRef}
				requiringNote={requiringNote}
				orgFlags={orgFlags}
				placeholder="Why is this flag being applied?"
			/>
		</div>
	)
}

export function RemoveFlagsDialogContent(props: {
	currentFlagIds: string[]
	flagIdsRef: React.MutableRefObject<string[]>
	reasonsRef: React.MutableRefObject<Record<string, string>>
}) {
	const orgFlags = BattlemetricsClient.useOrgFlags()
	// staged rather than removed on click: a misclick on a destructive action stays undoable while the dialog is open,
	// and a flag has to be staged before there's anywhere to write its reason
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
			<FlagReasonRows
				flagIds={staged}
				reasonsRef={props.reasonsRef}
				requiringNote={[]}
				orgFlags={orgFlags}
				placeholder="Why is this flag being removed?"
			/>
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
	const reasonsRef = React.useRef<Record<string, string>>({})

	function flagNames(ids: string[]) {
		return BM.resolveFlags(ids, orgFlags ?? []).map((f) => f.name).join(', ')
	}

	function resetDialogState() {
		flagIdsRef.current = []
		reasonsRef.current = {}
	}

	async function addFlags() {
		if (currentFlagIds === null) return
		resetDialogState()
		const result = await openDialog({
			title: 'Add Flags',
			description: "Add BattleMetrics flags to this player's profile.",
			content: <AddFlagsDialogContent currentFlagIds={currentFlagIds} flagIdsRef={flagIdsRef} reasonsRef={reasonsRef} />,
			buttons: [{ id: 'confirm', label: 'Add Flags' }],
		})
		if (result !== 'confirm') return
		const flagIds = flagIdsRef.current
		if (flagIds.length === 0) {
			toast.error('No flags selected')
			return
		}
		const res = await addMutation.mutateAsync({ playerId: props.playerId, flags: readFlagChanges(flagIds, reasonsRef) })
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

	async function removeFlags() {
		if (currentFlagIds === null) return
		resetDialogState()
		const result = await openDialog({
			title: 'Remove Flags',
			description: "Remove BattleMetrics flags from this player's profile.",
			variant: 'destructive',
			content: <RemoveFlagsDialogContent currentFlagIds={currentFlagIds} flagIdsRef={flagIdsRef} reasonsRef={reasonsRef} />,
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
			flags: readFlagChanges(flagIds, reasonsRef),
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
			<Item onClick={removeFlags} disabled={!currentFlagIds || currentFlagIds.length === 0}>Remove Flags...</Item>
		</>
	)
}

// the Flags context-menu entry: Add and Remove, each opening its own workflow
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
