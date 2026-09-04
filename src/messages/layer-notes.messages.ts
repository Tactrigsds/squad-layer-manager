import { def } from '@/models/messages.models'

// Freeform notes on a queue item, rendered `<author>: <text>` beside the item's tags.

export const addNote = def('Add note')

// menu entry that opens the add dialog
export const addNoteItem = def('Add note...')

// the same affordance, shrunk to fit inline beside a queue item that has no notes yet
export const addNoteInline = def('add note')

export const editNote = def('Edit note')

export const viewNotes = def('View {count} notes', (count: number) => ({ count }))

// on the popover holding one note, so a screen reader can tell them apart
export const noteGroup = def('Note')

export const edit = def('Edit')

export const cancel = def('Cancel')

export const save = def('Save')

export const add = def('Add')

export const placeholder = def('Anything worth knowing about this layer. Links are clickable.')

// the author of a note whose account no longer resolves
export const unknownAuthor = def('unknown')
