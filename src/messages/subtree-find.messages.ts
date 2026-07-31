import { def } from '@/models/messages.models'

export const placeholder = def('Find')

export const label = def('Find in this panel')

export const counter = def('{current} of {total}', (current: number, total: number) => ({ current, total }))

export const counterTruncated = def('{current} of {total}+', (current: number, total: number) => ({ current, total }))

export const noMatches = def('No results')

export const previous = def('Previous match')

export const next = def('Next match')

export const closeBar = def('Close find')

export const caseSensitive = def('Match case')

export const wholeWord = def('Match whole word')

export const unsupported = def('This browser cannot highlight matches.')
