import * as Msgs from '@/messages/shared'

// Freeform notes on a queue item, rendered `<author>: <text>` beside the item's tags.

export const addNote = Msgs.def('Add note')

// the same affordance, shrunk to fit inline beside a queue item that has no notes yet
export const addNoteInline = Msgs.def('add note')

export const editNote = Msgs.def('Edit note')

export const viewNotes = Msgs.def('View {count} notes', (count: number) => ({ count }))

// on the popover holding one note, so a screen reader can tell them apart
export const noteGroup = Msgs.def('Note')

export const edit = Msgs.def('Edit')

export const cancel = Msgs.def('Cancel')

export const save = Msgs.def('Save')

export const add = Msgs.def('Add')

export const placeholder = Msgs.def('Anything worth knowing about this layer. Links are clickable.')

// the author of a note whose account no longer resolves
export const unknownAuthor = Msgs.def('unknown')
