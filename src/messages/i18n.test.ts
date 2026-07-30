import { createElement, Fragment, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'

import * as I18n from '@/messages/i18n'
import { def, rt } from '@/models/messages.models'

describe('resolving a message against a locale', () => {
	test('a message with no catalogue is its own English', () => {
		expect(I18n.ambient.text(def('Close')())).toBe('Close')
		expect(I18n.translatorFor('de-DE').text(def('Close')())).toBe('Close')
	})

	test('a registered catalogue replaces it', () => {
		I18n.registerCatalogue('de-AT', { Close: 'Schließen' })
		expect(I18n.translatorFor('de-AT').text(def('Close')())).toBe('Schließen')
	})

	test('a key the catalogue is missing falls back to English rather than to the key', () => {
		I18n.registerCatalogue('de-CH', { Close: 'Schließen' })
		expect(I18n.translatorFor('de-CH').text(def('Save')())).toBe('Save')
	})

	test('the ambient locale applies when none is passed, and an explicit one overrides it', () => {
		I18n.registerCatalogue('de-LI', { Close: 'Schließen' })
		I18n.setAmbientLocale('de-LI')
		try {
			expect(I18n.ambient.text(def('Close')())).toBe('Schließen')
			expect(I18n.translatorFor(I18n.DEFAULT_LOCALE).text(def('Close')())).toBe('Close')
		} finally {
			I18n.setAmbientLocale(I18n.DEFAULT_LOCALE)
		}
	})
})

describe('messages that take arguments', () => {
	const addLayers = def('{count, plural, =0 {Add Layers} one {Add 1 Layer} other {Add # Layers}}', (count: number) => ({ count }))

	test('the ICU pattern selects a plural form in English', () => {
		expect(I18n.ambient.text(addLayers(0))).toBe('Add Layers')
		expect(I18n.ambient.text(addLayers(1))).toBe('Add 1 Layer')
		expect(I18n.ambient.text(addLayers(7))).toBe('Add 7 Layers')
	})

	test('a translation may use its own plural rules', () => {
		I18n.registerCatalogue('pl-PL', {
			'{count, plural, =0 {Add Layers} one {Add 1 Layer} other {Add # Layers}}':
				'{count, plural, one {# warstwa} few {# warstwy} other {# warstw}}',
		})
		expect(I18n.translatorFor('pl-PL').text(addLayers(1))).toBe('1 warstwa')
		expect(I18n.translatorFor('pl-PL').text(addLayers(3))).toBe('3 warstwy')
		expect(I18n.translatorFor('pl-PL').text(addLayers(9))).toBe('9 warstw')
	})

	test('the call site keeps the signature it had before the pattern existed', () => {
		const teamName = def(
			'{team, select, A {Team A} other {Team B}}{faction, select, none {} other { ({faction})}}',
			(team: 'A' | 'B', faction?: string) => ({ team, faction: faction ?? 'none' }),
		)
		expect(I18n.ambient.text(teamName('A'))).toBe('Team A')
		expect(I18n.ambient.text(teamName('B', 'USMC'))).toBe('Team B (USMC)')
	})
})

describe('two messages whose English is identical', () => {
	const dismiss = def('Cancel')
	const liftTimeout = def('Cancel', { context: 'lift a timeout' })

	test('share a key by default and can be told apart by a context', () => {
		I18n.registerCatalogue('de-LU', { Cancel: 'Abbrechen', 'Cancel [lift a timeout]': 'Aufheben' })
		expect(I18n.translatorFor('de-LU').text(dismiss())).toBe('Abbrechen')
		expect(I18n.translatorFor('de-LU').text(liftTimeout())).toBe('Aufheben')
	})

	test('the context never reaches the reader', () => {
		expect(I18n.ambient.text(liftTimeout())).toBe('Cancel')
	})
})

describe('choosing a locale for the reader', () => {
	test('a preference with no catalogue is ignored rather than adopted', () => {
		// adopting it would render English under that language's plural rules
		expect(I18n.negotiateLocale(['ja', 'ko'])).toBe(I18n.DEFAULT_LOCALE)
	})

	test('a region falls back to the language we do carry', () => {
		I18n.registerCatalogue('fr-FR', { Close: 'Fermer' })
		expect(I18n.negotiateLocale(['fr-CA'])).toBe('fr-FR')
		expect(I18n.negotiateLocale(['fr-FR'])).toBe('fr-FR')
	})

	test('preferences are taken in the reader’s order', () => {
		I18n.registerCatalogue('es-ES', { Close: 'Cerrar' })
		expect(I18n.negotiateLocale(['ja', 'es-ES'])).toBe('es-ES')
	})
})

describe('reading an Accept-Language header', () => {
	test('tags come out ordered by their q weights, ties keeping the header order', () => {
		expect(I18n.parseAcceptLanguage('da, en-gb;q=0.8, en;q=0.7')).toEqual(['da', 'en-gb', 'en'])
		expect(I18n.parseAcceptLanguage('en;q=0.7, da')).toEqual(['da', 'en'])
		expect(I18n.parseAcceptLanguage('de, fr')).toEqual(['de', 'fr'])
	})

	test('wildcards, rejections and garbage are dropped', () => {
		expect(I18n.parseAcceptLanguage('*, de;q=0, fr;q=abc, es')).toEqual(['es'])
		expect(I18n.parseAcceptLanguage(undefined)).toEqual([])
		expect(I18n.parseAcceptLanguage('')).toEqual([])
	})
})

describe('rendering rich text tags', () => {
	const tr = I18n.createTranslator({ locale: 'en' })
	const html = (node: ReactNode) => renderToStaticMarkup(createElement(Fragment, null, node))

	test('the standard formatting tags render without being provided', () => {
		const msg = def({ richText: rt('press <strong>{key}</strong> to <code>save</code>', { key: 'S' }) })
		expect(html(tr.richText(msg()))).toBe('press <strong>S</strong> to <code>save</code>')
	})

	test('withTags derives a translator that renders a custom tag', () => {
		const msg = def({ richText: rt('edited by <user>{name}</user>', { name: 'Alice' }) })
		const derived = tr.withTags({ user: (chunks) => createElement('a', { href: '#u' }, ...chunks) })
		expect(html(derived.richText(msg()))).toBe('edited by <a href="#u">Alice</a>')
	})

	test('a nested rich target renders with the outer translator&apos;s tags', () => {
		const inner = rt('<when>today</when>')
		const msg = def({ richText: rt('review: <verdict>{inner}</verdict>', { inner }) })
		const derived = tr.withTags({
			verdict: (chunks) => createElement('em', null, ...chunks),
			when: (chunks) => createElement('time', null, ...chunks),
		})
		expect(html(derived.richText(msg()))).toBe('review: <em><time>today</time></em>')
	})

	test('an empty tag pair carries a void element, the ICU spelling of a self-closing tag', () => {
		const msg = def({ richText: rt('one<br></br>two') })
		const derived = tr.withTags({ br: () => createElement('br') })
		expect(html(derived.richText(msg()))).toBe('one<br/>two')
	})
})
