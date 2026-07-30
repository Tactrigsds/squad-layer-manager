import * as Zus from '@/lib/zustand'
import * as I18n from '@/messages/i18n'
import type * as Msgs from '@/models/messages.models'

// The language this browser reads the app in. "auto" follows the browser's own preference list, which is the
// default and what almost everyone should stay on; a named locale is for reading the app in something other than
// what your browser asks for. Either way the answer is narrowed to a locale this build carries a catalogue for.

const STORAGE_KEY = 'ui-locale:v1'

// 'auto', or a locale tag. Not a union: `'auto' | string` collapses to `string` anyway.
export const AUTO = 'auto'
export type LocaleChoice = string

type LocaleStore = {
	choice: LocaleChoice
	locale: string
	setChoice: (choice: LocaleChoice) => void
}

let LocaleStore!: Zus.StoreApi<LocaleStore>

function resolve(choice: LocaleChoice) {
	return I18n.negotiateLocale(choice === AUTO ? navigator.languages : [choice])
}

export function setup() {
	LocaleStore = Zus.createStore<LocaleStore>((set) => {
		const choice = localStorage.getItem(STORAGE_KEY) ?? AUTO
		const locale = resolve(choice)
		I18n.setAmbientLocale(locale)
		return {
			choice,
			locale,
			setChoice: (choice: LocaleChoice) => {
				localStorage.setItem(STORAGE_KEY, choice)
				const locale = resolve(choice)
				set({ choice, locale })
				if (locale === I18n.getAmbientLocale()) return
				I18n.setAmbientLocale(locale)
				// Messages resolve against the ambient locale as they render, which React has no way to track, so
				// re-rendering would leave every already-mounted subtree in the old language. Reloading is the honest
				// version of "everything changes", and changing language is rare enough to afford it.
				window.location.reload()
			},
		}
	})
}

export function useLocale() {
	return Zus.useStore(LocaleStore)
}

// The viewer's translator, and what every client call site uses. A browser has exactly one viewer, so unlike the
// server there is nothing here for a translator to be ambiguous about: components, action handlers and store
// selectors all resolve against the same locale. It re-reads that locale per call, so it is safe to hold from
// before setup(), and changing language reloads the page (see setChoice), so nothing has to invalidate on it.
//
// A message whose pattern uses a custom tag needs the renderers for it: `tr.withTags({ user: ... })`, at module
// scope where they are static.
export const tr: Msgs.Translator = I18n.ambient

// Each language named in itself, which is what a reader who cannot read the current one needs.
export function endonym(locale: string) {
	try {
		return new Intl.DisplayNames([locale], { type: 'language' }).of(locale) ?? locale
	} catch {
		return locale
	}
}

export function availableLocales() {
	return I18n.availableLocales()
}
