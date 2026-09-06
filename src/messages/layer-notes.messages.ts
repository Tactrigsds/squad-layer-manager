import { def } from '@/models/messages.models'

// Freeform notes on a queue item, rendered `<author>: <text>` on a row under the layer name.

export const addNote = def('Add note')

// menu entry that opens the add dialog
export const addNoteItem = def('Add note...')

export const editNote = def('Edit note')

// the chip after the newest notes on the row, counting those it leaves out. Opens the full list
export const olderNotes = def('+{count} older', (count: number) => ({ count }))

export const viewAllNotes = def('View all {count} notes', (count: number) => ({ count }))

// on the popover holding one note, so a screen reader can tell them apart
export const noteGroup = def('Note')

export const edit = def('Edit')

export const cancel = def('Cancel')

export const save = def('Save')

export const add = def('Add')

export const placeholder = def('Anything worth knowing about this layer. Links are clickable.')

// the author of a note whose account no longer resolves
export const unknownAuthor = def('unknown')
