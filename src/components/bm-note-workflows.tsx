import { type UseQueryResult, useMutation, useQuery } from '@tanstack/react-query'
import * as Icons from 'lucide-react'
import React from 'react'

import { useNow } from '@/lib/react'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as BM_Msgs from '@/messages/battlemetrics.messages'
import * as MsgFmt from '@/messages/format'
import type * as Tgt from '@/messages/target'
import * as BM from '@/models/battlemetrics.models'
import * as RPC from '@/orpc.client'
import * as BattlemetricsClient from '@/systems/battlemetrics.client'
import * as ConfigClient from '@/systems/config.client'
import { tr } from '@/systems/messages.client'
import * as RbacClient from '@/systems/rbac.client'
import * as UsersClient from '@/systems/users.client'

import { PermissionDeniedTooltip } from './permission-denied-tooltip'
import type { MenuSlots } from './player-context-menu-options'
import { Label } from './ui/label'
import { useAlertDialog, useBlockDialogSubmit } from './ui/lazy-alert-dialog'
import { Textarea } from './ui/textarea'

export function AddNoteDialogContent(props: { noteRef: React.MutableRefObject<string>; playerCount: number }) {
	const { noteRef } = props
	const user = UsersClient.useLoggedInUser()
	// only flips when the note goes from empty to written or back, so typing doesn't re-render the dialog
	const [empty, setEmpty] = React.useState(true)
	useBlockDialogSubmit(empty)

	return (
		<div className="grid gap-1.5">
			<Label htmlFor="bm-note">{tr.text(BM_Msgs.noteLabel())}</Label>
			<Textarea
				id="bm-note"
				rows={5}
				maxLength={BM.NOTE_MAX_LENGTH}
				autoComplete="off"
				className="resize-y"
				placeholder={tr.text(BM_Msgs.notePlaceholder(props.playerCount))}
				onChange={(e) => {
					noteRef.current = e.target.value
					setEmpty(e.target.value.trim().length === 0)
				}}
				onKeyDown={(e) => {
					if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
						e.preventDefault()
						e.currentTarget.form?.requestSubmit()
					}
				}}
			/>
			<div className="flex justify-between gap-3 text-2xs text-muted-foreground">
				<span>{user && tr.text(BM_Msgs.noteSignature(BM.noteSignature(BM.webActorLabel(user))))}</span>
				<span className="shrink-0">{tr.text(BM_Msgs.noteSubmitHint())}</span>
			</div>
		</div>
	)
}

function useAddNoteAction(playerIds: string[], target: Tgt.Target) {
	const denied = RbacClient.useAccess('battlemetrics.addNote')
	const openDialog = useAlertDialog()
	const mutation = useMutation(RPC.orpc.battlemetrics.addNote.mutationOptions())
	const noteRef = React.useRef('')

	async function addNote() {
		if (playerIds.length === 0) return
		noteRef.current = ''
		const msg = tr.confirm(BM_Msgs.addNote(target))
		const result = await openDialog({
			title: msg.title,
			content: <AddNoteDialogContent noteRef={noteRef} playerCount={playerIds.length} />,
			buttons: [{ id: 'confirm', label: msg.confirmLabel }],
		})
		const note = noteRef.current.trim()
		if (result !== 'confirm' || note.length === 0) return
		const res = await mutation.mutateAsync({ playerIds, note })
		if (res.code !== 'ok') {
			toast.error(...tr.toast(BM_Msgs.noteFailed(res.code)))
			return
		}
		BattlemetricsClient.NotesActions.refreshLoaded(playerIds)
		toast(...tr.toast(BM_Msgs.noteAdded(res.notedCount, res.playerCount)))
	}

	return { addNote, denied, disabled: !!denied || playerIds.length === 0 }
}

// a player, squad or selection's context menu: the same note on every target's profile
export function AddNoteMenuItem(props: { slots: MenuSlots; playerIds: string[]; target: Tgt.Target; label?: string }) {
	const { Item } = props.slots
	const bmEnabled = Zus.useStore(ConfigClient.Store, ConfigClient.Sel.battlemetricsEnabled)
	const { addNote, denied, disabled } = useAddNoteAction(props.playerIds, props.target)
	if (!bmEnabled) return null
	return (
		<PermissionDeniedTooltip denied={denied}>
			<Item onClick={addNote} disabled={disabled}>
				{props.label ?? tr.text(BM_Msgs.addNoteItem())}
			</Item>
		</PermissionDeniedTooltip>
	)
}

// the player details window's entry point, beside the manage-flags button
export function PlayerNoteButton(props: { playerId: string; username?: string }) {
	const bmEnabled = Zus.useStore(ConfigClient.Store, ConfigClient.Sel.battlemetricsEnabled)
	const { addNote, denied, disabled } = useAddNoteAction([props.playerId], { kind: 'player', username: props.username })
	if (!bmEnabled) return null
	return (
		<PermissionDeniedTooltip denied={denied}>
			<button
				type="button"
				disabled={disabled}
				onClick={addNote}
				className="inline-flex items-center rounded p-0.5 text-muted-foreground hover:text-foreground transition-colors shrink-0 disabled:opacity-50 disabled:pointer-events-none"
				aria-label={tr.text(BM_Msgs.addNoteHint())}
				title={tr.text(BM_Msgs.addNoteHint())}
			>
				<Icons.NotebookPen className="h-3 w-3" />
			</button>
		</PermissionDeniedTooltip>
	)
}

const NOTES_ICON_BTN =
	'inline-flex items-center rounded p-0.5 text-muted-foreground hover:text-foreground transition-colors shrink-0 disabled:opacity-50 disabled:pointer-events-none'

// A player's BM notes, as two cells of the player details window's tag grid. Nothing is fetched until the admin
// asks: every load is a BattleMetrics request against the org's budget.
export function PlayerNotesRow(props: { playerId: string; username?: string }) {
	const [requested, setRequested] = React.useState(false)
	const query = useQuery({ ...BattlemetricsClient.playerNotesQueryOptions(props.playerId), enabled: requested })
	const [reloading, setReloading] = React.useState(false)

	if (!requested) {
		return (
			<>
				<span className="fd-lbl-k2 pt-1">{tr.text(BM_Msgs.notesLabel())}</span>
				<div>
					<button
						type="button"
						onClick={() => setRequested(true)}
						className="inline-flex h-5 items-center gap-1 rounded-[3px] border border-line-soft bg-ctl-lo px-2 text-2xs text-text-2 transition-colors hover:text-text"
					>
						<Icons.ChevronDown className="h-3 w-3" />
						{tr.text(BM_Msgs.loadNotes())}
					</button>
				</div>
			</>
		)
	}

	async function reload() {
		setReloading(true)
		try {
			await BattlemetricsClient.NotesActions.reload(props.playerId)
		} catch {
			void query.refetch()
		} finally {
			setReloading(false)
		}
	}

	const data = loadedNotes(query.data)
	return (
		<section
			aria-label={tr.text(BM_Msgs.notesLabel())}
			className="col-span-2 mt-0.5 overflow-hidden rounded-[3px] border border-border bg-ctl-lo"
		>
			<div className="flex items-center gap-1.5 border-b border-border bg-panel-hi py-1 ps-2 pe-1.5">
				<span className="fd-lbl-k2">
					{tr.text(BM_Msgs.notesLabel())}
					{data && ` · ${data.notes.length}`}
				</span>
				<span className="min-w-0 flex-1 truncate text-2xs text-text-3">
					{query.isFetching || reloading ? tr.text(BM_Msgs.notesLoading()) : data && <LoadedAgo time={data.fetchedAt} />}
				</span>
				<PlayerNoteButton playerId={props.playerId} username={props.username} />
				<button
					type="button"
					className={NOTES_ICON_BTN}
					disabled={reloading || query.isFetching}
					onClick={() => void reload()}
					aria-label={tr.text(BM_Msgs.reloadNotes())}
					title={tr.text(BM_Msgs.reloadNotes())}
				>
					<Icons.RefreshCw className={cn('h-3 w-3', reloading && 'animate-spin')} />
				</button>
				<button
					type="button"
					className={NOTES_ICON_BTN}
					onClick={() => setRequested(false)}
					aria-label={tr.text(BM_Msgs.hideNotes())}
					title={tr.text(BM_Msgs.hideNotes())}
				>
					<Icons.ChevronUp className="h-3 w-3" />
				</button>
			</div>
			<PlayerNotesBody playerId={props.playerId} query={query} onRetry={() => void reload()} />
		</section>
	)
}

function LoadedAgo(props: { time: number }) {
	// the clock only ticks every 30s, so a list loaded since its last tick would otherwise read as loaded in the future
	const now = Math.max(useNow(30_000), props.time)
	return <>{tr.text(BM_Msgs.notesLoadedAt(MsgFmt.formatRelativeTime(props.time, { now })))}</>
}

type NotesResponse = Awaited<ReturnType<typeof RPC.orpc.battlemetrics.listPlayerNotes.call>>

function loadedNotes(res: NotesResponse | undefined): Extract<NotesResponse, { code: 'ok' }> | undefined {
	return res?.code === 'ok' ? (res as Extract<NotesResponse, { code: 'ok' }>) : undefined
}

function PlayerNotesBody(props: { playerId: string; query: UseQueryResult<NotesResponse>; onRetry: () => void }) {
	const profileUrl = BattlemetricsClient.usePlayerProfile(props.playerId)?.profileUrl
	const { data, isPending, isError } = props.query

	if (isPending) {
		return (
			<div className="grid gap-2 px-2 py-2.5" aria-hidden>
				<div className="h-2 w-2/5 rounded-sm bg-panel-hi" />
				<div className="h-2 w-11/12 rounded-sm bg-panel" />
				<div className="h-2 w-3/4 rounded-sm bg-panel" />
			</div>
		)
	}
	if (isError || data.code === 'err:disabled' || data.code === 'err:permission-denied') {
		return (
			<div className="flex items-center gap-2 px-2 py-2.5 text-xs text-destructive">
				<Icons.CircleAlert className="h-3.5 w-3.5 shrink-0" />
				<span className="flex-1">{tr.text(BM_Msgs.notesFailed())}</span>
				<button
					type="button"
					onClick={props.onRetry}
					className="h-5 rounded-[3px] border border-line-soft bg-panel px-2 text-2xs text-text hover:bg-panel-hi"
				>
					{tr.text(BM_Msgs.retryNotes())}
				</button>
			</div>
		)
	}
	if (data.code === 'err:not-found') {
		return <p className="m-0 px-2 py-3 text-center text-xs text-text-3">{tr.text(BM_Msgs.notesNotFound())}</p>
	}
	if (data.notes.length === 0) {
		return <p className="m-0 px-2 py-3 text-center text-xs text-text-3">{tr.text(BM_Msgs.noNotes())}</p>
	}
	return (
		<>
			<ol className="m-0 max-h-52 list-none overflow-auto p-0">
				{data.notes.map((note) => (
					<NoteItem key={note.id} note={note} />
				))}
			</ol>
			{(profileUrl || data.truncated) && (
				<div className="flex items-center justify-center gap-2 border-t border-panel-hi px-2 py-1 text-2xs">
					{data.truncated && <span className="text-text-3">{tr.text(BM_Msgs.notesTruncated(data.notes.length))}</span>}
					{profileUrl && (
						<a
							href={profileUrl}
							target="_blank"
							rel="noreferrer"
							className="inline-flex items-center gap-1 text-primary hover:underline"
						>
							<Icons.ExternalLink className="h-3 w-3" />
							{tr.text(BM_Msgs.allNotesOnBm())}
						</a>
					)}
				</div>
			)}
		</>
	)
}

const SOURCE_CLS = 'rounded-[2px] px-1 py-px text-[9px] font-semibold tracking-wide'

function NoteItem({ note }: { note: BM.PlayerNote }) {
	const author = note.author
	const name = author.kind === 'slm' ? author.name : (author.name ?? tr.text(BM_Msgs.unknownBmUser()))
	return (
		<li className="grid gap-0.5 border-b border-panel-hi px-2 py-1.5 last:border-b-0">
			<div className="flex items-center gap-1.5">
				<span className="truncate text-xs font-semibold">{name}</span>
				{author.kind === 'slm' ? (
					<span className={cn(SOURCE_CLS, 'bg-[#414144] text-text-2')}>{tr.text(BM_Msgs.noteSourceSlm())}</span>
				) : (
					<span className={cn(SOURCE_CLS, 'bg-admin/15 text-admin')}>{tr.text(BM_Msgs.noteSourceBm())}</span>
				)}
				<time
					className="ms-auto shrink-0 text-2xs text-text-3"
					dateTime={new Date(note.createdAt).toISOString()}
					title={new Date(note.createdAt).toLocaleString()}
				>
					{MsgFmt.formatRelativeTime(note.createdAt)}
				</time>
			</div>
			{note.flagChange && (
				<div className="flex items-center gap-1 text-xs font-semibold">
					<Icons.Flag className="h-3 w-3 shrink-0" />
					{tr.text(BM_Msgs.noteFlagChange(note.flagChange.action, note.flagChange.flagName))}
				</div>
			)}
			{note.text && <p className="m-0 whitespace-pre-wrap break-words text-xs text-text-2">{note.text}</p>}
		</li>
	)
}
