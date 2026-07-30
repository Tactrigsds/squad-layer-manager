// The catalogues this build ships, registered at boot on both sides: the server before it renders anything
// (landing pages, warns), the client before the locale store negotiates. One static import per catalogue,
// so every bundler and tsx inline them without config, and a build cannot silently drop a locale the way a
// runtime directory scan could.
//
// To add a locale: `pnpm i18n:extract`, copy locales/en.json to locales/<tag>.json, translate it, then
// import it here and register it. en itself is the source language, so it has no catalogue: a message IS
// its English.
//
//   import * as I18n from '@/messages/i18n'
//   import de from './locales/de.json'
//   I18n.registerCatalogue('de', de)

export function register() {}
