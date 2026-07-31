import { def } from '@/models/messages.models'

export const placeholder = def('Find')

export const label = def('Find in this panel')

export const counter = def('{current} of {total}', (current: number, total: number) => ({ current, total }))

export const counterTruncated = def('{current} of {total}+', (current: number, total: number) => ({ current, total }))

export const noMatches = def('No results')

// "result", not "match": "Previous match" is already the activity panel's word for the previous game, and a
// translator handed one shared key cannot tell the two apart
export const previous = def('Previous result')

export const next = def('Next result')

export const closeBar = def('Close find')

export const caseSensitive = def('Match case')

export const wholeWord = def('Match whole word')

export const unsupported = def('This browser cannot highlight matches.')
