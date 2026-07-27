import { describe, expect, test } from 'vitest'

import * as I18n from '@/messages/i18n'
import * as Msgs from '@/messages/shared'

describe('resolving a message against a locale', () => {
	test('a message with no catalogue is its own English', () => {
		expect(Msgs.def('Close')().text()).toBe('Close')
		expect(Msgs.def('Close')().text('de-DE')).toBe('Close')
	})

	test('a registered catalogue replaces it', () => {
		I18n.registerCatalogue('de-AT', { Close: 'Schließen' })
		expect(Msgs.def('Close')().text('de-AT')).toBe('Schließen')
	})

	test('a key the catalogue is missing falls back to English rather than to the key', () => {
		I18n.registerCatalogue('de-CH', { Close: 'Schließen' })
		expect(Msgs.def('Save')().text('de-CH')).toBe('Save')
	})

	test('the ambient locale applies when none is passed, and an explicit one overrides it', () => {
		I18n.registerCatalogue('de-LI', { Close: 'Schließen' })
		I18n.setAmbientLocale('de-LI')
		try {
			expect(Msgs.def('Close')().text()).toBe('Schließen')
			expect(Msgs.def('Close')().text(I18n.DEFAULT_LOCALE)).toBe('Close')
		} finally {
			I18n.setAmbientLocale(I18n.DEFAULT_LOCALE)
		}
	})
})

describe('messages that take arguments', () => {
	const addLayers = Msgs.def('{count, plural, =0 {Add Layers} one {Add 1 Layer} other {Add # Layers}}', (count: number) => ({ count }))

	test('the ICU pattern selects a plural form in English', () => {
		expect(addLayers(0).text()).toBe('Add Layers')
		expect(addLayers(1).text()).toBe('Add 1 Layer')
		expect(addLayers(7).text()).toBe('Add 7 Layers')
	})

	test('a translation may use its own plural rules', () => {
		I18n.registerCatalogue('pl-PL', {
			'{count, plural, =0 {Add Layers} one {Add 1 Layer} other {Add # Layers}}':
				'{count, plural, one {# warstwa} few {# warstwy} other {# warstw}}',
		})
		expect(addLayers(1).text('pl-PL')).toBe('1 warstwa')
		expect(addLayers(3).text('pl-PL')).toBe('3 warstwy')
		expect(addLayers(9).text('pl-PL')).toBe('9 warstw')
	})

	test('the call site keeps the signature it had before the pattern existed', () => {
		const teamName = Msgs.def(
			'{team, select, A {Team A} other {Team B}}{faction, select, none {} other { ({faction})}}',
			(team: 'A' | 'B', faction?: string) => ({ team, faction: faction ?? 'none' }),
		)
		expect(teamName('A').text()).toBe('Team A')
		expect(teamName('B', 'USMC').text()).toBe('Team B (USMC)')
	})
})

describe('two messages whose English is identical', () => {
	const dismiss = Msgs.def('Cancel')
	const liftTimeout = Msgs.def('Cancel', { context: 'lift a timeout' })

	test('share a key by default and can be told apart by a context', () => {
		I18n.registerCatalogue('de-LU', { Cancel: 'Abbrechen', 'Cancel [lift a timeout]': 'Aufheben' })
		expect(dismiss().text('de-LU')).toBe('Abbrechen')
		expect(liftTimeout().text('de-LU')).toBe('Aufheben')
	})

	test('the context never reaches the reader', () => {
		expect(liftTimeout().text()).toBe('Cancel')
	})
})
