import * as Icons from 'lucide-react'
import React from 'react'

import { RichText } from '@/components/rich-text'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { UserLabel } from '@/components/user-avatar'
import * as Browser from '@/lib/browser'
import { cn, REVEAL_ON_ITEM_HOVER } from '@/lib/utils'
import * as LNote_Msgs from '@/messages/layer-notes.messages'
import * as LNote from '@/models/layer-notes.models'
import type * as USR from '@/models/users.models'
import * as RBAC from '@/rbac.models'
import { tr } from '@/systems/messages.client'
import * as RbacClient from '@/systems/rbac.client'
import * as UsersClient from '@/systems/users.client'

// Freeform notes on a queue item, rendered `<author>: <text>` on their own row under the layer name. A note belongs
// to its author: anyone else needs queue:manage-all-notes to touch it (the server enforces the same rule).

type Editing = { note: LNote.Note } | 'new' | null

export function LayerNotes(props: {
	serverId: string
	notes: LNote.Note[] | undefined
	onEdit: (noteId: LNote.NoteId, text: string) => void
	onDelete: (noteId: LNote.NoteId) => void
	disabled?: boolean
	className?: string
}) {
	const notes = props.notes ?? []
	const [editing, setEditing] = React.useState<Editing>(null)
	if (notes.length === 0) return null

	const submit = (text: string) => {
		if (editing && editing !== 'new') props.onEdit(editing.note.id, text)
		setEditing(null)
	}

	const { recent, older } = LNote.partitionForRow(notes)
	return (
		<span className={cn('flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5', props.className)}>
			{recent.map((note) => (
				<NoteChip
					key={note.id}
					serverId={props.serverId}
					note={note}
					disabled={props.disabled}
					onEdit={() => setEditing({ note })}
					onDelete={() => props.onDelete(note.id)}
				/>
			))}
			{older > 0 && (
				<NoteListPopover
					serverId={props.serverId}
					notes={notes}
					older={older}
					disabled={props.disabled}
					onEdit={(note) => setEditing({ note })}
					onDelete={props.onDelete}
				/>
			)}
			<LayerNoteDialog state={editing} onClose={() => setEditing(null)} onSubmit={submit} />
		</span>
	)
}

// Sits on the layer name row beside the add-tag button, whatever the item's notes, so the row never changes shape
export function AddNoteButton(props: {
	onAdd: (text: string) => void
	disabled?: boolean
	// only meaningful inside a `group/single-item` (see REVEAL_ON_ITEM_HOVER)
	revealOnHover?: boolean
}) {
	const [open, setOpen] = React.useState(false)
	return (
		<>
			<Button
				variant="ghost"
				size="sm"
				title={tr.text(LNote_Msgs.addNote())}
				aria-label={tr.text(LNote_Msgs.addNote())}
				disabled={props.disabled}
				onClick={() => setOpen(true)}
				className={cn(
					'h-4 shrink-0 gap-0.5 px-1 text-xs text-muted-foreground font-normal',
					props.revealOnHover && REVEAL_ON_ITEM_HOVER,
				)}
			>
				<span>+</span>
				<Icons.MessageSquare className="h-3 w-3" />
			</Button>
			<LayerNoteDialog
				state={open ? 'new' : null}
				onClose={() => setOpen(false)}
				onSubmit={(text) => {
					props.onAdd(text)
					setOpen(false)
				}}
			/>
		</>
	)
}

function NoteChip(props: { serverId: string; note: LNote.Note; disabled?: boolean; onEdit: () => void; onDelete: () => void }) {
	// touch has no hover, so there a tap opens the card instead
	const coarse = Browser.useCoarsePointer()
	const body = (
		<NoteBody serverId={props.serverId} note={props.note} disabled={props.disabled} onEdit={props.onEdit} onDelete={props.onDelete} />
	)
	// one line each, whatever the length: the card carries the full text
	const text = (
		<>
			<AuthorName userId={props.note.author} />: <RichText text={props.note.text} className="whitespace-nowrap" />
		</>
	)
	if (coarse) {
		return (
			<Popover>
				<PopoverTrigger asChild>
					<button type="button" className="min-w-0 max-w-full truncate select-none text-left text-xs text-muted-foreground">
						{text}
					</button>
				</PopoverTrigger>
				<PopoverContent align="start" className="w-72 space-y-2 p-3">
					{body}
				</PopoverContent>
			</Popover>
		)
	}
	return (
		<HoverCard openDelay={200}>
			<HoverCardTrigger asChild>
				<span className="min-w-0 max-w-full truncate cursor-default select-none text-xs text-muted-foreground">{text}</span>
			</HoverCardTrigger>
			<HoverCardContent className="w-72 space-y-2 p-3">{body}</HoverCardContent>
		</HoverCard>
	)
}

// every note, newest first, behind the chip that counts the ones the row leaves out
function NoteListPopover(props: {
	serverId: string
	notes: LNote.Note[]
	older: number
	disabled?: boolean
	onEdit: (note: LNote.Note) => void
	onDelete: (noteId: LNote.NoteId) => void
}) {
	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button
					variant="ghost"
					size="sm"
					title={tr.text(LNote_Msgs.viewAllNotes(props.notes.length))}
					className="h-4 shrink-0 gap-0.5 px-1 text-xs font-normal text-muted-foreground"
				>
					<Icons.MessageSquare className="h-3 w-3" />
					{tr.text(LNote_Msgs.olderNotes(props.older))}
				</Button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-96 max-h-80 space-y-3 overflow-y-auto p-3">
				{props.notes.toReversed().map((note) => (
					<NoteBody
						key={note.id}
						serverId={props.serverId}
						note={note}
						disabled={props.disabled}
						onEdit={() => props.onEdit(note)}
						onDelete={() => props.onDelete(note.id)}
					/>
				))}
			</PopoverContent>
		</Popover>
	)
}

function NoteBody(props: { serverId: string; note: LNote.Note; disabled?: boolean; onEdit: () => void; onDelete: () => void }) {
	const canManage = useCanManageNote(props.serverId, props.note)
	return (
		<div role="group" aria-label={tr.text(LNote_Msgs.noteGroup())} className="space-y-1">
			<UserLabel userId={props.note.author} />
			<p className="text-sm">
				<RichText text={props.note.text} />
			</p>
			{canManage && !props.disabled && (
				<div className="flex gap-1">
					<Button variant="outline" size="sm" className="h-6 flex-1 text-xs" onClick={props.onEdit}>
						<Icons.Pencil className="mr-1 h-3 w-3" />
						{tr.text(LNote_Msgs.edit())}
					</Button>
					<Button variant="outline" size="sm" className="h-6 text-xs text-destructive" onClick={props.onDelete}>
						<Icons.Trash2 className="h-3 w-3" />
					</Button>
				</div>
			)}
		</div>
	)
}

function AuthorName(props: { userId: USR.UserId }) {
	const user = UsersClient.useResolvedUser(props.userId)
	return <span className="font-medium text-foreground">{user?.displayName ?? tr.text(LNote_Msgs.unknownAuthor())}</span>
}

export function LayerNoteDialog(props: { state: Editing; onClose: () => void; onSubmit: (text: string) => void }) {
	return (
		<Dialog open={props.state !== null} onOpenChange={(next) => !next && props.onClose()}>
			<DialogContent className="max-w-md">{props.state && <NoteDialogBody {...props} state={props.state} />}</DialogContent>
		</Dialog>
	)
}

function NoteDialogBody(props: { state: Exclude<Editing, null>; onClose: () => void; onSubmit: (text: string) => void }) {
	const existing = props.state === 'new' ? undefined : props.state.note
	const [length, setLength] = React.useState(existing?.text.length ?? 0)
	const textRef = React.useRef<HTMLTextAreaElement>(null)

	const submit = () => {
		const text = textRef.current?.value.trim() ?? ''
		if (text.length === 0 || text.length > LNote.MAX_LENGTH) return
		props.onSubmit(text)
	}

	return (
		<>
			<DialogHeader>
				<DialogTitle>{existing ? tr.text(LNote_Msgs.editNote()) : tr.text(LNote_Msgs.addNote())}</DialogTitle>
			</DialogHeader>
			<Textarea
				autoFocus
				ref={textRef}
				defaultValue={existing?.text ?? ''}
				maxLength={LNote.MAX_LENGTH}
				className="min-h-24 text-sm"
				placeholder={tr.text(LNote_Msgs.placeholder())}
				onChange={(e) => setLength(e.target.value.trim().length)}
				onKeyDown={(e) => {
					if (!Browser.isSubmitChord(e)) return
					e.preventDefault()
					submit()
				}}
			/>
			<span className="text-xs text-muted-foreground">
				{length} / {LNote.MAX_LENGTH}
			</span>
			<DialogFooter>
				<Button variant="outline" onClick={props.onClose}>
					{tr.text(LNote_Msgs.cancel())}
				</Button>
				<Button disabled={length === 0} onClick={submit}>
					{existing ? tr.text(LNote_Msgs.save()) : tr.text(LNote_Msgs.add())}
				</Button>
			</DialogFooter>
		</>
	)
}

function useCanManageNote(serverId: string, note: LNote.Note) {
	const user = UsersClient.useLoggedInUser()
	const manageAllDenied = RbacClient.usePermsCheck(RBAC.perm('queue:manage-all-notes', { serverId }))
	return LNote.isAuthor(note, user?.discordId) || manageAllDenied === null
}
