import { RichText } from '@/components/rich-text'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { UserLabel } from '@/components/user-avatar'
import { cn, REVEAL_ON_ITEM_HOVER } from '@/lib/utils'
import * as LNote from '@/models/layer-notes.models'
import type * as USR from '@/models/users.models'
import * as RBAC from '@/rbac.models'
import * as RbacClient from '@/systems/rbac.client'
import * as UsersClient from '@/systems/users.client'
import * as Icons from 'lucide-react'
import React from 'react'

// Freeform notes on a queue item, rendered `<author>: <text>` beside the item's tags. A note belongs to its author:
// anyone else needs queue:manage-all-notes to touch it (the server enforces the same rule).

type Editing = { note: LNote.Note } | 'new' | null

export function LayerNotes(props: {
	notes: LNote.Note[] | undefined
	onAdd: (text: string) => void
	onEdit: (noteId: LNote.NoteId, text: string) => void
	onDelete: (noteId: LNote.NoteId) => void
	disabled?: boolean
	className?: string
	// as with the tag control, only meaningful inside a `group/single-item` (see REVEAL_ON_ITEM_HOVER)
	revealAddOnHover?: boolean
}) {
	const notes = props.notes ?? []
	const [editing, setEditing] = React.useState<Editing>(null)

	const submit = (text: string) => {
		if (editing === 'new') props.onAdd(text)
		else if (editing) props.onEdit(editing.note.id, text)
		setEditing(null)
	}

	return (
		<span className={cn('flex flex-wrap items-center gap-1', props.className)}>
			{LNote.displayInline(notes)
				? notes.map(note => (
					<NoteChip
						key={note.id}
						note={note}
						disabled={props.disabled}
						onEdit={() => setEditing({ note })}
						onDelete={() => props.onDelete(note.id)}
					/>
				))
				: notes.length > 0 && (
					<NoteListPopover
						notes={notes}
						disabled={props.disabled}
						onEdit={(note) => setEditing({ note })}
						onDelete={props.onDelete}
					/>
				)}
			<Button
				variant="ghost"
				size="sm"
				title="Add note"
				disabled={props.disabled}
				onClick={() => setEditing('new')}
				className={cn(
					'h-4 shrink-0 px-1 text-xs text-muted-foreground font-normal',
					notes.length === 0 ? 'gap-0.5' : 'w-4 px-0',
					props.revealAddOnHover && REVEAL_ON_ITEM_HOVER,
				)}
			>
				<Icons.MessageSquarePlus className="h-3 w-3" />
				{notes.length === 0 && <span>add note</span>}
			</Button>
			<NoteDialog state={editing} onClose={() => setEditing(null)} onSubmit={submit} />
		</span>
	)
}

function NoteChip(props: { note: LNote.Note; disabled?: boolean; onEdit: () => void; onDelete: () => void }) {
	return (
		<HoverCard openDelay={200}>
			<HoverCardTrigger asChild>
				<span className="cursor-default select-none text-xs text-muted-foreground">
					<AuthorName userId={props.note.author} />: <RichText text={props.note.text} className="whitespace-normal" />
				</span>
			</HoverCardTrigger>
			<HoverCardContent className="w-72 space-y-2 p-3">
				<NoteBody note={props.note} disabled={props.disabled} onEdit={props.onEdit} onDelete={props.onDelete} />
			</HoverCardContent>
		</HoverCard>
	)
}

function NoteListPopover(props: {
	notes: LNote.Note[]
	disabled?: boolean
	onEdit: (note: LNote.Note) => void
	onDelete: (noteId: LNote.NoteId) => void
}) {
	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button variant="ghost" size="sm" className="h-4 px-1 text-xs text-muted-foreground font-normal gap-0.5">
					<Icons.MessageSquare className="h-3 w-3" />
					View {props.notes.length} notes
				</Button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-96 max-h-80 space-y-3 overflow-y-auto p-3">
				{props.notes.map(note => (
					<NoteBody
						key={note.id}
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

function NoteBody(props: { note: LNote.Note; disabled?: boolean; onEdit: () => void; onDelete: () => void }) {
	const canManage = useCanManageNote(props.note)
	return (
		<div role="group" aria-label="Note" className="space-y-1">
			<UserLabel userId={props.note.author} />
			<p className="text-sm">
				<RichText text={props.note.text} />
			</p>
			{canManage && !props.disabled && (
				<div className="flex gap-1">
					<Button variant="outline" size="sm" className="h-6 flex-1 text-xs" onClick={props.onEdit}>
						<Icons.Pencil className="mr-1 h-3 w-3" />
						Edit
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
	return <span className="font-medium text-foreground">{user?.displayName ?? 'unknown'}</span>
}

function NoteDialog(props: { state: Editing; onClose: () => void; onSubmit: (text: string) => void }) {
	return (
		<Dialog open={props.state !== null} onOpenChange={(next) => !next && props.onClose()}>
			<DialogContent className="max-w-md">
				{props.state && <NoteDialogBody {...props} state={props.state} />}
			</DialogContent>
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
				<DialogTitle>{existing ? 'Edit note' : 'Add note'}</DialogTitle>
			</DialogHeader>
			<Textarea
				autoFocus
				ref={textRef}
				defaultValue={existing?.text ?? ''}
				maxLength={LNote.MAX_LENGTH}
				className="min-h-24 text-sm"
				placeholder="Anything worth knowing about this layer. Links are clickable."
				onChange={(e) => setLength(e.target.value.trim().length)}
			/>
			<span className="text-xs text-muted-foreground">{length} / {LNote.MAX_LENGTH}</span>
			<DialogFooter>
				<Button variant="outline" onClick={props.onClose}>Cancel</Button>
				<Button disabled={length === 0} onClick={submit}>{existing ? 'Save' : 'Add'}</Button>
			</DialogFooter>
		</>
	)
}

function useCanManageNote(note: LNote.Note) {
	const user = UsersClient.useLoggedInUser()
	const manageAllDenied = RbacClient.usePermsCheck(RBAC.perm('queue:manage-all-notes'))
	return LNote.isAuthor(note, user?.discordId) || manageAllDenied === null
}
