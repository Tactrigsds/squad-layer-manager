import { z } from 'zod'

import { createId } from '@/lib/id'
import * as USR from '@/models/users.models'

// Freeform notes on a layer item. A note belongs to whoever wrote it: nobody else can reword or drop it without
// queue:manage-all-notes (enforced in layer-queue.server, mirrored in the UI).

export const ID_LENGTH = 8
export const MAX_LENGTH = 280

export const NoteIdSchema = z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${ID_LENGTH}}$`))
export type NoteId = z.infer<typeof NoteIdSchema>

export const TextSchema = z.string().trim().min(1).max(MAX_LENGTH)

export const NoteSchema = z.object({
	id: NoteIdSchema,
	author: USR.UserIdSchema,
	text: TextSchema,
})
export type Note = z.infer<typeof NoteSchema>

export const NotesSchema = z.array(NoteSchema)

export function createNoteId() {
	return createId(ID_LENGTH)
}

export function isAuthor(note: Note, userId?: USR.UserId) {
	return userId !== undefined && note.author === userId
}

// how many notes an item shows in the queue row before collapsing to a single "view N notes" button. Kept low because
// they share the row with the layer name and its tags.
export const MAX_INLINE = 2

// a note long enough to crowd out the rest of the row is collapsed with the others rather than truncated in place
export const INLINE_CHAR_BUDGET = 80

export function displayInline(notes: Note[]) {
	if (notes.length === 0) return false
	if (notes.length > MAX_INLINE) return false
	return notes.reduce((total, note) => total + note.text.length, 0) <= INLINE_CHAR_BUDGET
}
