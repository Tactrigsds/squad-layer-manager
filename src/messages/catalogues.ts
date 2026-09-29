import type * as ICU from '@/messages/icu'
import * as I18n from '@/messages/i18n'

// The translated catalogues this build ships, registered at boot on both sides: the server before it renders
// anything (landing pages, warns), the client before the locale store negotiates. One static import per catalogue,
// so every bundler and tsx inline them without config, and a build cannot silently drop a locale the way a runtime
// directory scan could.
//
// English is not here: it is the source language, and @/messages/i18n carries its compiled form built in, so no
// boot path can miss it.
//
// To add a locale: copy locales/en.json to locales/<tag>.json, translate it, then import and register
// data/generated/messages/<tag>.compiled.json here.
//
//   import * as I18n from '@/messages/i18n'
//   import de from '../../data/generated/messages/de.compiled.json'
//   I18n.registerCatalogue('de', de)

export function register() {}

// Development builds also carry the pseudo-locales (src/scripts/pseudo-locale.ts). Dynamic so production bundles
// never include them; the caller guards on import.meta.env.DEV, which lets the bundler drop these imports entirely.
export async function registerPseudo() {
	const [xa, xb] = await Promise.all([
		import('../../data/generated/messages/en-XA.compiled.json'),
		import('../../data/generated/messages/ar-XB.compiled.json'),
	])
	I18n.registerCatalogue('en-XA', xa.default as unknown as Record<string, ICU.Entry>)
	I18n.registerCatalogue('ar-XB', xb.default as unknown as Record<string, ICU.Entry>)
}
