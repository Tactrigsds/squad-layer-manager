import { def, t } from '@/models/messages.models'

// shared by the index pages that list saved entities, such as filters and rotations

export const author = def('Author')

export const anyAuthor = def('Anyone')

export const sort = def('Sort')

export const ascending = def('Ascending')

export const descending = def('Descending')

export const moreActions = def('More actions')

export const copyLink = def('Copy link')

export const linkCopied = def(() => ({ toast: [t('Link copied')] }))

// on a search result row, before the part of the entity that matched
export const matchedOn = def('Match')
