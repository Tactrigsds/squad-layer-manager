/**
 * Rendering the {{var}} templates admins write, with SLM's semantics: no HTML escaping, an unknown
 * variable renders empty, and a malformed template falls back to the raw string rather than throwing.
 *
 * `templateVars` is how a plugin validates one it was given, and tells a template that references nothing
 * (`[]`) from one that is malformed (`undefined`).
 */
export { renderTemplate, templateVars } from '@/lib/templating'
export type { TemplateVar } from '@/lib/templating'
