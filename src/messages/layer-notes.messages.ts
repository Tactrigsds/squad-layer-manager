import * as Msgs from '@/messages/shared'

// Freeform notes on a queue item, rendered `<author>: <text>` beside the item's tags.

export const addNote = Msgs.def(() => ({ text: () => 'Add note' }))

// the same affordance, shrunk to fit inline beside a queue item that has no notes yet
export const addNoteInline = Msgs.def(() => ({ text: () => 'add note' }))

export const editNote = Msgs.def(() => ({ text: () => 'Edit note' }))

export const viewNotes = Msgs.def((count: number) => ({ text: () => `View ${count} notes` }))

// on the popover holding one note, so a screen reader can tell them apart
export const noteGroup = Msgs.def(() => ({ text: () => 'Note' }))

export const edit = Msgs.def(() => ({ text: () => 'Edit' }))

export const cancel = Msgs.def(() => ({ text: () => 'Cancel' }))

export const save = Msgs.def(() => ({ text: () => 'Save' }))

export const add = Msgs.def(() => ({ text: () => 'Add' }))

export const placeholder = Msgs.def(() => ({ text: () => 'Anything worth knowing about this layer. Links are clickable.' }))

// the author of a note whose account no longer resolves
export const unknownAuthor = Msgs.def(() => ({ text: () => 'unknown' }))
