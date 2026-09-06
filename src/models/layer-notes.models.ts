import { createId } from '@/lib/id'
import { z } from '@/lib/zod'
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

// how many notes an item shows on its row. Each is clamped to one line, so the count is what bounds the row's height
export const MAX_INLINE = 2

// notes are stored oldest first; the row shows the newest, and the count of what it leaves out
export function partitionForRow(notes: Note[]): { recent: Note[]; older: number } {
	const recent = notes.slice(-MAX_INLINE).reverse()
	return { recent, older: notes.length - recent.length }
}
