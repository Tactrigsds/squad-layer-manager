import { BmFlagSelect, FlagLabel } from '@/components/bm-flag-picker'
import { toast } from '@/lib/toast'
import * as ZusUtils from '@/lib/zustand'
import type * as BM from '@/models/battlemetrics.models'
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
import { Input } from './ui/input'
import { Label } from './ui/label'
import { useAlertDialog } from './ui/lazy-alert-dialog'

// The dialog is the player's flag list, edited in place: existing flags can be struck off, new ones appended. Only a
// row that's actually changing asks for a reason, and each carries its own -- one flag's justification is not another's,
// and the note posted for it quotes only that text.

type RowChange = 'adding' | 'removing' | undefined

function FlagRow(props: {
	id: string
	change: RowChange
	requiresReason: boolean
	orgFlags: BM.PlayerFlag[] | undefined
	reasonsRef: React.MutableRefObject<Record<string, string>>
	onToggle: () => void
}) {
	const removing = props.change === 'removing'
	return (
		<li className="grid gap-1.5 rounded border px-2 py-1.5">
			<div className="flex items-center justify-between gap-2">
				<span className={removing ? 'opacity-40 line-through' : undefined}>
					<FlagLabel id={props.id} flags={props.orgFlags} />
				</span>
				<div className="flex items-center gap-2">
					{props.change && <span className="text-xs text-muted-foreground capitalize">{props.change}</span>}
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="h-6 px-1"
						title={removing ? 'Keep this flag' : props.change === 'adding' ? "Don't add this flag" : 'Remove this flag'}
						onClick={props.onToggle}
					>
						{removing ? <Icons.Undo2 className="h-3 w-3" /> : <Icons.X className="h-3 w-3 text-destructive" />}
					</Button>
				</div>
			</div>
			{props.change && (
				<div className="grid gap-1">
					<Label className="text-xs font-normal text-muted-foreground">
						Reason {props.requiresReason ? <span className="text-destructive">(required)</span> : '(optional)'}
					</Label>
					<Input
						autoComplete="off"
						className="h-7"
						placeholder={removing ? 'Why is this flag being removed?' : 'Why is this flag being applied?'}
						defaultValue={props.reasonsRef.current[props.id] ?? ''}
						onChange={(e) => {
							props.reasonsRef.current[props.id] = e.target.value
						}}
					/>
				</div>
			)}
		</li>
	)
}

export function ManageFlagsDialogContent(props: {
	currentFlagIds: string[]
	addRef: React.MutableRefObject<string[]>
	removeRef: React.MutableRefObject<string[]>
	reasonsRef: React.MutableRefObject<Record<string, string>>
}) {
	const orgFlags = BattlemetricsClient.useOrgFlags()
	const requiringNote = ZusUtils.useStore(SettingsClient.PublicSettingsStore, (s) => s?.playerFlagsRequiringNote ?? [])
	// staged rather than applied on click: a misclick on a destructive action stays undoable while the dialog is open
	const [staged, setStaged] = React.useState<string[]>(() => props.removeRef.current)
	const [pending, setPending] = React.useState<string[]>(() => props.addRef.current)
	// while true the add button is replaced by the picker it summoned
	const [picking, setPicking] = React.useState(false)

	const addable = (orgFlags ?? []).map((f) => f.id)
		.filter((id) => !props.currentFlagIds.includes(id) && !pending.includes(id))

	function toggleStaged(id: string) {
		const next = staged.includes(id) ? staged.filter((f) => f !== id) : [...staged, id]
		setStaged(next)
		props.removeRef.current = next
	}

	function dropPending(id: string) {
		const next = pending.filter((f) => f !== id)
		setPending(next)
		props.addRef.current = next
	}

	function addPending(id: string) {
		const next = [...pending, id]
		setPending(next)
		props.addRef.current = next
		setPicking(false)
	}

	return (
		<div className="grid gap-2">
			<Label>Flags</Label>
			{props.currentFlagIds.length === 0 && pending.length === 0 && (
				<p className="text-xs text-muted-foreground">This player has no flags.</p>
			)}
			<ul className="grid gap-1">
				{props.currentFlagIds.map((id) => (
					<FlagRow
						key={id}
						id={id}
						change={staged.includes(id) ? 'removing' : undefined}
						requiresReason={false}
						orgFlags={orgFlags}
						reasonsRef={props.reasonsRef}
						onToggle={() => toggleStaged(id)}
					/>
				))}
				{pending.map((id) => (
					<FlagRow
						key={id}
						id={id}
						change="adding"
						requiresReason={requiringNote.includes(id)}
						orgFlags={orgFlags}
						reasonsRef={props.reasonsRef}
						onToggle={() => dropPending(id)}
					/>
				))}
			</ul>
			{picking
				? (
					<BmFlagSelect
						value={undefined}
						only={addable}
						autoOpen
						placeholder="Select a flag..."
						// dismissing without picking puts the button back, so the picker is never left sitting there empty
						onOpenChange={(open) => {
							if (!open) setPicking(false)
						}}
						onChange={addPending}
					/>
				)
				: (
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="justify-self-start"
						disabled={addable.length === 0}
						title={addable.length === 0 ? 'This player already has every flag in the organization' : undefined}
						onClick={() => setPicking(true)}
					>
						<Icons.Plus className="mr-1 h-3 w-3" />
						Add flag
					</Button>
				)}
			<span className="text-xs text-muted-foreground">
				Each reason is posted to the player's BattleMetrics profile as its own note.
			</span>
		</div>
	)
}

// add-only variant of the flag dialog: no current flags, no removals -- just the set of flags to apply to every
// target, each with its own reason. Shared by the bulk-selection and squad menus, where the targets' existing flags
// differ and there's nothing to diff against.
export function AddFlagsDialogContent(props: {
	addRef: React.MutableRefObject<string[]>
	reasonsRef: React.MutableRefObject<Record<string, string>>
}) {
	const orgFlags = BattlemetricsClient.useOrgFlags()
	const requiringNote = ZusUtils.useStore(SettingsClient.PublicSettingsStore, (s) => s?.playerFlagsRequiringNote ?? [])
	const [pending, setPending] = React.useState<string[]>(() => props.addRef.current)
	// while true the add button is replaced by the picker it summoned
	const [picking, setPicking] = React.useState(false)

	const addable = (orgFlags ?? []).map((f) => f.id).filter((id) => !pending.includes(id))

	function dropPending(id: string) {
		const next = pending.filter((f) => f !== id)
		setPending(next)
		props.addRef.current = next
	}

	function addPending(id: string) {
		const next = [...pending, id]
		setPending(next)
		props.addRef.current = next
		setPicking(false)
	}

	return (
		<div className="grid gap-2">
			<Label>Flags to add</Label>
			{pending.length === 0 && <p className="text-xs text-muted-foreground">No flags selected yet.</p>}
			<ul className="grid gap-1">
				{pending.map((id) => (
					<FlagRow
						key={id}
						id={id}
						change="adding"
						requiresReason={requiringNote.includes(id)}
						orgFlags={orgFlags}
						reasonsRef={props.reasonsRef}
						onToggle={() => dropPending(id)}
					/>
				))}
			</ul>
			{picking
				? (
					<BmFlagSelect
						value={undefined}
						only={addable}
						autoOpen
						placeholder="Select a flag..."
						onOpenChange={(open) => {
							if (!open) setPicking(false)
						}}
						onChange={addPending}
					/>
				)
				: (
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="justify-self-start"
						disabled={addable.length === 0}
						onClick={() => setPicking(true)}
					>
						<Icons.Plus className="mr-1 h-3 w-3" />
						Add flag
					</Button>
				)}
			<span className="text-xs text-muted-foreground">
				Each reason is posted to every selected player's BattleMetrics profile as its own note.
			</span>
		</div>
	)
}

// only the flags actually being changed: a row's text survives in the ref after its row goes away, so it can be
// restored if the flag comes back, but it must never be submitted for a flag that isn't changing
function readFlagChanges(flagIds: string[], reasonsRef: React.MutableRefObject<Record<string, string>>): BM.FlagChange[] {
	return flagIds.map((id) => ({ id, reason: reasonsRef.current[id]?.trim() || undefined }))
}

function useManageFlagsAction(playerId: string) {
	const denied = RbacClient.usePermsCheck(RBAC.perm('battlemetrics:write-flags'))
	const openDialog = useAlertDialog()
	const currentFlagIds = BattlemetricsClient.usePlayerFlagIds(playerId)
	const mutation = useMutation(RPC.orpc.battlemetrics.updateFlags.mutationOptions())
	const addRef = React.useRef<string[]>([])
	const removeRef = React.useRef<string[]>([])
	const reasonsRef = React.useRef<Record<string, string>>({})

	async function manageFlags() {
		if (currentFlagIds === null) return
		addRef.current = []
		removeRef.current = []
		reasonsRef.current = {}
		const result = await openDialog({
			title: 'Manage Flags',
			description: "Add or remove BattleMetrics flags on this player's profile.",
			content: (
				<ManageFlagsDialogContent
					currentFlagIds={currentFlagIds}
					addRef={addRef}
					removeRef={removeRef}
					reasonsRef={reasonsRef}
				/>
			),
			buttons: [{ id: 'confirm', label: 'Apply' }],
		})
		if (result !== 'confirm') return
		const add = readFlagChanges(addRef.current, reasonsRef)
		const remove = readFlagChanges(removeRef.current, reasonsRef)
		if (add.length === 0 && remove.length === 0) {
			toast.error('No changes to apply')
			return
		}
		const res = await mutation.mutateAsync({ playerId, add, remove })
		if (res.code === 'err:reason-required') {
			toast.error('Reason required', { description: `These flags require a reason: ${res.flags.join(', ')}` })
			return
		}
		if (res.code !== 'ok') {
			toast.error('Failed to update flags', { description: res.code })
			return
		}
		const summary = [
			...res.added.map((f) => `+${f.name}`),
			...res.removed.map((f) => `−${f.name}`),
		].join(', ')
		toast(`Updated flags: ${summary}`, {
			description: res.noteAdded ? undefined : 'The flags were updated, but a BattleMetrics note failed to post.',
		})
	}

	// null means BM data hasn't resolved for this player yet: there's nothing to edit
	return { manageFlags, denied, disabled: !!denied || currentFlagIds === null }
}

// the context-menu entry
export function PlayerFlagsMenuItem(props: { slots: MenuSlots; playerId: string; label?: string }) {
	const { Item } = props.slots
	const { manageFlags, denied, disabled } = useManageFlagsAction(props.playerId)
	return (
		<PermissionDeniedTooltip denied={denied}>
			<Item onClick={manageFlags} disabled={disabled}>{props.label ?? 'Manage Flags...'}</Item>
		</PermissionDeniedTooltip>
	)
}

function useAddFlagsAction(playerIds: string[], targetDescription: string) {
	const denied = RbacClient.usePermsCheck(RBAC.perm('battlemetrics:write-flags'))
	const openDialog = useAlertDialog()
	const mutation = useMutation(RPC.orpc.battlemetrics.addFlags.mutationOptions())
	const addRef = React.useRef<string[]>([])
	const reasonsRef = React.useRef<Record<string, string>>({})

	async function addFlags() {
		if (playerIds.length === 0) return
		addRef.current = []
		reasonsRef.current = {}
		const result = await openDialog({
			title: 'Add Flags',
			description: `Add BattleMetrics flags to ${targetDescription}.`,
			content: <AddFlagsDialogContent addRef={addRef} reasonsRef={reasonsRef} />,
			buttons: [{ id: 'confirm', label: 'Apply' }],
		})
		if (result !== 'confirm') return
		const add = readFlagChanges(addRef.current, reasonsRef)
		if (add.length === 0) {
			toast.error('No flags to add')
			return
		}
		const res = await mutation.mutateAsync({ playerIds, add })
		if (res.code === 'err:reason-required') {
			toast.error('Reason required', { description: `These flags require a reason: ${res.flags.join(', ')}` })
			return
		}
		if (res.code !== 'ok') {
			toast.error('Failed to add flags', { description: res.code })
			return
		}
		toast(`Flagged ${res.flaggedCount} of ${res.playerCount} players`, {
			description: res.noteAdded ? undefined : 'The flags were added, but a BattleMetrics note failed to post.',
		})
	}

	return { addFlags, denied, disabled: !!denied || playerIds.length === 0 }
}

// bulk-selection and squad menu entry: add-only flags across every target
export function AddPlayerFlagsMenuItem(props: { slots: MenuSlots; playerIds: string[]; targetDescription: string; label?: string }) {
	const { Item } = props.slots
	const { addFlags, denied, disabled } = useAddFlagsAction(props.playerIds, props.targetDescription)
	return (
		<PermissionDeniedTooltip denied={denied}>
			<Item onClick={addFlags} disabled={disabled}>{props.label ?? 'Add Flags...'}</Item>
		</PermissionDeniedTooltip>
	)
}

// the player-details-window entry point: the same dialog, off the flag row's edit affordance
export function PlayerFlagsButton(props: { playerId: string }) {
	const { manageFlags, denied, disabled } = useManageFlagsAction(props.playerId)
	return (
		<PermissionDeniedTooltip denied={denied}>
			<button
				type="button"
				disabled={disabled}
				onClick={manageFlags}
				className="inline-flex items-center rounded p-0.5 text-muted-foreground hover:text-foreground transition-colors shrink-0 disabled:opacity-50 disabled:pointer-events-none"
				title="Manage flags"
			>
				<Icons.Pencil className="h-3 w-3" />
			</button>
		</PermissionDeniedTooltip>
	)
}
