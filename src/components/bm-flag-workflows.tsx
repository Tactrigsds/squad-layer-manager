import { useMutation } from '@tanstack/react-query'
import * as Icons from 'lucide-react'
import React from 'react'

import { BmFlagSelect, FlagLabel } from '@/components/bm-flag-picker'
import { toast } from '@/lib/toast'
import * as Zus from '@/lib/zustand'
import * as AAR_Msgs from '@/messages/admin-action-reasons.messages'
import * as BM_Msgs from '@/messages/battlemetrics.messages'
import type * as Tgt from '@/messages/target'
import type * as BM from '@/models/battlemetrics.models'
import * as RPC from '@/orpc.client'
import * as RBAC from '@/rbac.models'
import * as BattlemetricsClient from '@/systems/battlemetrics.client'
import * as ConfigClient from '@/systems/config.client'
import { tr } from '@/systems/messages.client'
import * as RbacClient from '@/systems/rbac.client'
import * as SettingsClient from '@/systems/settings.client'

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
	const reasonsRef = props.reasonsRef
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
						title={
							removing
								? tr.text(BM_Msgs.keepFlag())
								: props.change === 'adding'
									? tr.text(BM_Msgs.dontAddFlag())
									: tr.text(BM_Msgs.removeFlag())
						}
						onClick={props.onToggle}
					>
						{removing ? <Icons.Undo2 className="h-3 w-3" /> : <Icons.X className="h-3 w-3 text-destructive" />}
					</Button>
				</div>
			</div>
			{props.change && (
				<div className="grid gap-1">
					<Label className="text-xs font-normal text-muted-foreground">
						{tr.richText(
							AAR_Msgs.reasonLabel(
								props.requiresReason ? (
									<span className="text-destructive">{tr.text(AAR_Msgs.reasonRequired())}</span>
								) : (
									tr.text(AAR_Msgs.reasonOptional())
								),
							),
						)}
					</Label>
					<Input
						autoComplete="off"
						className="h-7"
						placeholder={removing ? tr.text(BM_Msgs.whyRemoving()) : tr.text(BM_Msgs.whyApplying())}
						defaultValue={reasonsRef.current[props.id] ?? ''}
						onChange={(e) => {
							reasonsRef.current[props.id] = e.target.value
						}}
					/>
				</div>
			)}
		</li>
	)
}

export function ManageFlagsDialogContent(props: {
	playerId: string
	addRef: React.MutableRefObject<string[]>
	removeRef: React.MutableRefObject<string[]>
	reasonsRef: React.MutableRefObject<Record<string, string>>
}) {
	const { addRef, removeRef } = props
	const orgFlags = BattlemetricsClient.useOrgFlags()
	const requiringNote = Zus.useStore(SettingsClient.PublicSettingsStore, (s) => s?.playerFlagsRequiringNote ?? [])
	// read live so the refresh kicked off when the dialog opened lands here without reopening it
	const currentFlagIds = BattlemetricsClient.usePlayerFlagIds(props.playerId) ?? []
	// staged rather than applied on click: a misclick on a destructive action stays undoable while the dialog is open
	const [staged, setStaged] = React.useState<string[]>(() => removeRef.current)
	const [pending, setPending] = React.useState<string[]>(() => addRef.current)
	// while true the add button is replaced by the picker it summoned
	const [picking, setPicking] = React.useState(false)

	const addable = (orgFlags ?? []).map((f) => f.id).filter((id) => !currentFlagIds.includes(id) && !pending.includes(id))

	function toggleStaged(id: string) {
		const next = staged.includes(id) ? staged.filter((f) => f !== id) : [...staged, id]
		setStaged(next)
		removeRef.current = next
	}

	function dropPending(id: string) {
		const next = pending.filter((f) => f !== id)
		setPending(next)
		addRef.current = next
	}

	function addPending(id: string) {
		const next = [...pending, id]
		setPending(next)
		addRef.current = next
		setPicking(false)
	}

	return (
		<div className="grid gap-2">
			<Label>{tr.text(BM_Msgs.flagsLabel())}</Label>
			{currentFlagIds.length === 0 && pending.length === 0 && (
				<p className="text-xs text-muted-foreground">{tr.text(BM_Msgs.noFlags())}</p>
			)}
			<ul className="grid gap-1">
				{currentFlagIds.map((id) => (
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
			{picking ? (
				<BmFlagSelect
					value={undefined}
					only={addable}
					autoOpen
					placeholder={tr.text(BM_Msgs.selectFlag())}
					// dismissing without picking puts the button back, so the picker is never left sitting there empty
					onOpenChange={(open) => {
						if (!open) setPicking(false)
					}}
					onChange={addPending}
				/>
			) : (
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="justify-self-start"
					disabled={addable.length === 0}
					title={addable.length === 0 ? tr.text(BM_Msgs.hasEveryFlag()) : undefined}
					onClick={() => setPicking(true)}
				>
					<Icons.Plus className="mr-1 h-3 w-3" />
					{tr.text(BM_Msgs.addFlag())}
				</Button>
			)}
			<span className="text-xs text-muted-foreground">{tr.text(BM_Msgs.reasonsBecomeNotes('player'))}</span>
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
	const { addRef } = props
	const orgFlags = BattlemetricsClient.useOrgFlags()
	const requiringNote = Zus.useStore(SettingsClient.PublicSettingsStore, (s) => s?.playerFlagsRequiringNote ?? [])
	const [pending, setPending] = React.useState<string[]>(() => addRef.current)
	// while true the add button is replaced by the picker it summoned
	const [picking, setPicking] = React.useState(false)

	const addable = (orgFlags ?? []).map((f) => f.id).filter((id) => !pending.includes(id))

	function dropPending(id: string) {
		const next = pending.filter((f) => f !== id)
		setPending(next)
		addRef.current = next
	}

	function addPending(id: string) {
		const next = [...pending, id]
		setPending(next)
		addRef.current = next
		setPicking(false)
	}

	return (
		<div className="grid gap-2">
			<Label>{tr.text(BM_Msgs.flagsToAdd())}</Label>
			{pending.length === 0 && <p className="text-xs text-muted-foreground">{tr.text(BM_Msgs.noFlagsSelected())}</p>}
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
			{picking ? (
				<BmFlagSelect
					value={undefined}
					only={addable}
					autoOpen
					placeholder={tr.text(BM_Msgs.selectFlag())}
					onOpenChange={(open) => {
						if (!open) setPicking(false)
					}}
					onChange={addPending}
				/>
			) : (
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="justify-self-start"
					disabled={addable.length === 0}
					onClick={() => setPicking(true)}
				>
					<Icons.Plus className="mr-1 h-3 w-3" />
					{tr.text(BM_Msgs.addFlag())}
				</Button>
			)}
			<span className="text-xs text-muted-foreground">{tr.text(BM_Msgs.reasonsBecomeNotes('selection'))}</span>
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
	const refresh = BattlemetricsClient.useRefreshPlayerBmData()
	const mutation = useMutation(RPC.orpc.battlemetrics.updateFlags.mutationOptions())
	const addRef = React.useRef<string[]>([])
	const removeRef = React.useRef<string[]>([])
	const reasonsRef = React.useRef<Record<string, string>>({})

	async function manageFlags() {
		if (currentFlagIds === null) return
		addRef.current = []
		removeRef.current = []
		reasonsRef.current = {}
		// pull fresh flags in case they moved since this player's data was last polled; the dialog reads them live
		void refresh.mutateAsync({ playerIds: [playerId] })
		const msg = tr.confirm(BM_Msgs.manageFlags())
		const result = await openDialog({
			title: msg.title,
			description: msg.description,
			content: <ManageFlagsDialogContent playerId={playerId} addRef={addRef} removeRef={removeRef} reasonsRef={reasonsRef} />,
			buttons: [{ id: 'confirm', label: msg.confirmLabel }],
		})
		if (result !== 'confirm') return
		const add = readFlagChanges(addRef.current, reasonsRef)
		const remove = readFlagChanges(removeRef.current, reasonsRef)
		if (add.length === 0 && remove.length === 0) {
			toast.error(...tr.toast(BM_Msgs.noChanges()))
			return
		}
		const res = await mutation.mutateAsync({ playerId, add, remove })
		if (res.code === 'err:reason-required') {
			toast.error(...tr.toast(BM_Msgs.reasonRequired(res.flags)))
			return
		}
		if (res.code !== 'ok') {
			toast.error(...tr.toast(BM_Msgs.updateFailed(res.code)))
			return
		}
		toast(...tr.toast(BM_Msgs.flagsUpdated(res.added, res.removed, res.noteAdded)))
	}

	// null means BM data hasn't resolved for this player yet: there's nothing to edit
	return { manageFlags, denied, disabled: !!denied || currentFlagIds === null }
}

// the context-menu entry
export function PlayerFlagsMenuItem(props: { slots: MenuSlots; playerId: string; label?: string }) {
	const { Item } = props.slots
	const bmEnabled = Zus.useStore(ConfigClient.Store, ConfigClient.Sel.battlemetricsEnabled)
	const { manageFlags, denied, disabled } = useManageFlagsAction(props.playerId)
	if (!bmEnabled) return null
	return (
		<PermissionDeniedTooltip denied={denied}>
			<Item onClick={manageFlags} disabled={disabled}>
				{props.label ?? 'Manage Flags...'}
			</Item>
		</PermissionDeniedTooltip>
	)
}

function useAddFlagsAction(playerIds: string[], target: Tgt.Target) {
	const denied = RbacClient.usePermsCheck(RBAC.perm('battlemetrics:write-flags'))
	const openDialog = useAlertDialog()
	const refresh = BattlemetricsClient.useRefreshPlayerBmData()
	const mutation = useMutation(RPC.orpc.battlemetrics.addFlags.mutationOptions())
	const addRef = React.useRef<string[]>([])
	const reasonsRef = React.useRef<Record<string, string>>({})

	async function addFlags() {
		if (playerIds.length === 0) return
		addRef.current = []
		reasonsRef.current = {}
		// the server re-diffs against live flags per player; refreshing keeps its skip-already-flagged decision current
		void refresh.mutateAsync({ playerIds })
		const msg = tr.confirm(BM_Msgs.addFlags(target))
		const result = await openDialog({
			title: msg.title,
			description: msg.description,
			content: <AddFlagsDialogContent addRef={addRef} reasonsRef={reasonsRef} />,
			buttons: [{ id: 'confirm', label: msg.confirmLabel }],
		})
		if (result !== 'confirm') return
		const add = readFlagChanges(addRef.current, reasonsRef)
		if (add.length === 0) {
			toast.error(...tr.toast(BM_Msgs.noFlagsToAdd()))
			return
		}
		const res = await mutation.mutateAsync({ playerIds, add })
		if (res.code === 'err:reason-required') {
			toast.error(...tr.toast(BM_Msgs.reasonRequired(res.flags)))
			return
		}
		if (res.code !== 'ok') {
			toast.error(...tr.toast(BM_Msgs.addFailed(res.code)))
			return
		}
		toast(...tr.toast(BM_Msgs.flagsAdded(res.flaggedCount, res.playerCount, res.noteAdded)))
	}

	return { addFlags, denied, disabled: !!denied || playerIds.length === 0 }
}

// bulk-selection and squad menu entry: add-only flags across every target
export function AddPlayerFlagsMenuItem(props: { slots: MenuSlots; playerIds: string[]; target: Tgt.Target; label?: string }) {
	const { Item } = props.slots
	const bmEnabled = Zus.useStore(ConfigClient.Store, ConfigClient.Sel.battlemetricsEnabled)
	const { addFlags, denied, disabled } = useAddFlagsAction(props.playerIds, props.target)
	if (!bmEnabled) return null
	return (
		<PermissionDeniedTooltip denied={denied}>
			<Item onClick={addFlags} disabled={disabled}>
				{props.label ?? 'Add Flags...'}
			</Item>
		</PermissionDeniedTooltip>
	)
}

// the player-details-window entry point: the same dialog, off the flag row's edit affordance
export function PlayerFlagsButton(props: { playerId: string }) {
	const bmEnabled = Zus.useStore(ConfigClient.Store, ConfigClient.Sel.battlemetricsEnabled)
	const { manageFlags, denied, disabled } = useManageFlagsAction(props.playerId)
	if (!bmEnabled) return null
	return (
		<PermissionDeniedTooltip denied={denied}>
			<button
				type="button"
				disabled={disabled}
				onClick={manageFlags}
				className="inline-flex items-center rounded p-0.5 text-muted-foreground hover:text-foreground transition-colors shrink-0 disabled:opacity-50 disabled:pointer-events-none"
				title={tr.text(BM_Msgs.manageFlagsHint())}
			>
				<Icons.Pencil className="h-3 w-3" />
			</button>
		</PermissionDeniedTooltip>
	)
}
