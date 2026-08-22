// The translated catalogues this build ships, registered at boot on both sides: the server before it renders
// anything (landing pages, warns), the client before the locale store negotiates. One static import per catalogue,
// so every bundler and tsx inline them without config, and a build cannot silently drop a locale the way a runtime
// directory scan could.
//
// English is not here: it is the source language, and @/messages/i18n carries its compiled form built in, so no
// boot path can miss it.
//
// To add a locale: `pnpm i18n:extract`, copy locales/en.json to locales/<tag>.json, translate it, run
// `pnpm i18n:extract` again to compile the translation, then import and register the compiled file here.
//
//   import * as I18n from '@/messages/i18n'
//   import de from './locales/de.compiled.json'
//   I18n.registerCatalogue('de', de)

export function register() {}
