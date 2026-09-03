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
