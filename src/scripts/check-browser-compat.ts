import { parseSync, traverse } from '@babel/core'
import bcd from '@mdn/browser-compat-data' with { type: 'json' }
import type { CompatStatement, SimpleSupportStatement, SupportStatement } from '@mdn/browser-compat-data'
import * as fs from 'node:fs'
import * as path from 'node:path'
import postcss from 'postcss'

import { BROWSER_FLOOR } from '../browser-support.ts'

// Checks the built client for platform features none of the browsers we support implement. Run with
// `pnpm check:compat`, after a client build.
//
// This reads dist/ rather than src/ deliberately. Most of the shipped code is dependencies -- radix, dnd-kit,
// codemirror, react -- and a source-level lint would never see any of it, which is where the interesting
// misses are. The cost is that the javascript is minified, so identifiers are the only thing left to match on,
// and that is what shapes the three tiers below.
//
// Nothing here proves a feature is reached at runtime: a library that feature-detects before calling shows up
// exactly like one that does not. A hit is a question ("is this guarded?"), and the answer goes in ALLOWED.

type Finding = { kind: string; feature: string; misses: string[] }

const CLIENT_ASSETS = 'dist/assets'

// Every feature below is present in the bundle and unsupported somewhere, and has been checked. Keep the reason:
// re-deriving it is the whole cost of this check.
const ALLOWED: Record<string, string> = {
	// the name in the bundle is not the platform feature BCD matched it to. The javascript is minified, so a
	// member is matched on its name alone, and these are the collisions that produces.
	'IntersectionObserver.scrollMargin': "codemirror's own scrollMargin() on its scroll-margin facet",
	'ML.createContext': 'React.createContext',
	'PerformanceResourceTiming.contentEncoding': "zod's `_zod.bag.contentEncoding` on its base64 check",
	'Sanitizer.allowElement': "react-markdown's `allowElement` option",
	'Window.setImmediate': 'a bundled node shim that defines setImmediate itself rather than reading the global',
	'Window.clearImmediate': 'as Window.setImmediate',

	// guarded: the bundle tests for the feature before using it
	Highlight: 'subtree-find checks CSS.highlights and Highlight (lib/subtree-find.ts, isSupported)',
	'css:selector:::highlight': 'the same guard; without the api the find bar still finds and scrolls, it just paints nothing',
	'Document.startViewTransition': "tanstack router tests `'startViewTransition' in document` and falls back to a plain navigation",
	'Navigator.scheduling': "react's scheduler reads navigator.scheduling?.isInputPending and falls back to a time slice",
	'Scheduling.isInputPending': 'the same read',
	'Navigator.connection': 'read behind `navigator.connection &&` to estimate bandwidth',
	'Element.scrollIntoViewIfNeeded': 'codemirror tests for it and falls back to its own scroll math',
	'Element.checkVisibility': 'radix tests `typeof el.checkVisibility === "function"` when collecting tabbables',
	'Selection.getComposedRanges': 'codemirror reads it behind `if (sel.getComposedRanges)` for shadow-dom selections',
	'Error.captureStackTrace': "read as `'captureStackTrace' in Error ? ... : noop`",
	'NavigateEvent.canIntercept': 'a navigation-api handler that starts with `e.canIntercept &&`',
	'Navigation.currentEntry': 'the same handler',
	'TouchEvent.changedTouches': "read as `'changedTouches' in e ? ... : ...`",

	// lowered at build time
	'Symbol.dispose': 'the `using` lowering reads `Symbol.dispose || Symbol.for("Symbol.dispose")`',
	'Symbol.asyncDispose': 'as Symbol.dispose',

	// reached only on a platform we do not target, or with no consequence when it is missing
	'EditContext.updateSelection': 'codemirror builds an EditContext only under `window.EditContext && android`',
	'EditContext.updateSelectionBounds': 'the same path',
	'EditContext.updateCharacterBounds': 'the same path',
	'TextFormat.underlineStyle': 'the same path',
	'TextFormat.underlineThickness': 'the same path',
	'TextFormatUpdateEvent.getTextFormats': 'the same path',
	'TextUpdateEvent.updateRangeStart': 'the same path',
	'TextUpdateEvent.updateRangeEnd': 'the same path',
	'HTMLElement.autocapitalize': 'codemirror reads contentDOM.autocapitalize on an ios-only shift-key path',
	'IdleDeadline.timeRemaining': 'inside a requestIdleCallback callback, which is itself feature-detected',
	'TouchEvent.targetTouches': 'touch input, which this app does not target',
	'css:property:-webkit-tap-highlight-color': 'suppresses a touch-only tap flash; there is nothing to suppress on desktop',
	'css:selector:::-webkit-inner-spin-button': "tailwind's preflight normalising number inputs; firefox keeps its own spinner",
	'css:selector::open': "tailwind's `open:` variant emits it inside :is(), which drops the selectors it cannot parse",
	'css:selector::popover-open': 'as :open',
	'css:property:text-wrap': 'only chrome 111-113 lack it, and the fallback is ordinary wrapping',
	'css:property:backdrop-filter': 'safari below 18; the fallback is an opaque backdrop',
}

function versionAtLeast(version: string, floor: string) {
	const a = version.split('.').map(Number)
	const b = floor.split('.').map(Number)
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const d = (a[i] ?? 0) - (b[i] ?? 0)
		if (d !== 0) return d > 0
	}
	return false
}

// BCD gives a browser either one support statement or a list of them, newest first, and the list exists to
// describe prefixes and removals. Only the unprefixed, unrenamed entry says what plain code gets.
function plainSupport(support: SupportStatement | undefined): SimpleSupportStatement | undefined {
	if (!support) return undefined
	if (!Array.isArray(support)) return support
	return support.find((s) => !s.prefix && !s.alternative_name) ?? support[0]
}

function missesFloor(compat: CompatStatement | undefined) {
	if (!compat) return null
	const misses: string[] = []
	for (const [browser, floor] of Object.entries(BROWSER_FLOOR)) {
		const added = plainSupport(compat.support[browser as keyof typeof compat.support])?.version_added
		if (added === false || added === undefined || added === 'preview') {
			misses.push(`${browser}: never`)
			continue
		}
		if (versionAtLeast(added.replace(/^≤/, ''), floor)) misses.push(`${browser}: ${added}`)
	}
	return misses.length ? misses : null
}

function readAssets(ext: string) {
	if (!fs.existsSync(CLIENT_ASSETS)) {
		console.error(`no ${CLIENT_ASSETS}: build the client first (\`pnpm build:client\`)`)
		process.exit(2)
	}
	return fs
		.readdirSync(CLIENT_ASSETS)
		.filter((f) => f.endsWith(ext))
		.map((f) => ({ file: f, code: fs.readFileSync(path.join(CLIENT_ASSETS, f), 'utf8') }))
}

// The globals a browser exposes under a lowercase name, whose members BCD files under the interface. Without
// these, `navigator.clipboard` and `document.startViewTransition` are invisible to the dotted tier.
const INSTANCE_GLOBALS: Record<string, string> = {
	navigator: 'Navigator',
	document: 'Document',
	window: 'Window',
	screen: 'Screen',
	history: 'History',
	location: 'Location',
	performance: 'Performance',
	crypto: 'Crypto',
	localStorage: 'Storage',
	sessionStorage: 'Storage',
	caches: 'CacheStorage',
	indexedDB: 'IDBFactory',
}

function collectSymbols() {
	// free identifiers: names with no binding in any enclosing scope, so a reference to the platform rather than
	// to a bundled class. This is what separates the real `Highlight` from rxjs's own `Observable`.
	const freeGlobals = new Set<string>()
	// `A.b` where A is a free identifier, the only form precise enough to check a member against a named object
	const dotted = new Set<string>()
	// every non-computed property name in the bundle, for members distinctive enough to need no receiver
	const properties = new Set<string>()

	for (const { file, code } of readAssets('.js')) {
		const ast = parseSync(code, { sourceType: 'module', filename: file, configFile: false, babelrc: false })
		if (!ast) throw new Error(`could not parse ${file}`)
		traverse(ast, {
			ReferencedIdentifier(p) {
				if (!p.scope.hasBinding(p.node.name, { noGlobals: true })) freeGlobals.add(p.node.name)
			},
			MemberExpression(p) {
				const { object, property, computed } = p.node
				if (computed || property.type !== 'Identifier') return
				properties.add(property.name)
				if (object.type !== 'Identifier') return
				if (p.scope.hasBinding(object.name, { noGlobals: true })) return
				dotted.add(`${INSTANCE_GLOBALS[object.name] ?? object.name}.${property.name}`)
			},
		})
	}
	return { freeGlobals, dotted, properties }
}

// A member name that only one interface in the whole of BCD declares can be matched on its own: `.getBBox()`
// in minified code is the SVG one or nothing. A name several interfaces share tells us nothing about which,
// and a short one collides with ordinary application code, so both are left to the dotted tier.
function distinctiveMembers() {
	const owners = new Map<string, number>()
	for (const entry of Object.values(bcd.api)) {
		for (const member of Object.keys(entry)) {
			if (!member.startsWith('__')) owners.set(member, (owners.get(member) ?? 0) + 1)
		}
	}
	return (member: string) => member.length >= 12 && owners.get(member) === 1
}

function scanJs(): Finding[] {
	const { freeGlobals, dotted, properties } = collectSymbols()
	const isDistinctive = distinctiveMembers()
	const findings: Finding[] = []

	for (const [iface, entry] of Object.entries(bcd.api) as [string, Record<string, { __compat?: CompatStatement }>][]) {
		const ifaceMisses = missesFloor(entry.__compat as CompatStatement | undefined)
		if (ifaceMisses && freeGlobals.has(iface)) findings.push({ kind: 'global', feature: iface, misses: ifaceMisses })
		for (const [member, node] of Object.entries(entry)) {
			if (member.startsWith('__')) continue
			const misses = missesFloor((node as { __compat?: CompatStatement }).__compat)
			if (!misses) continue
			if (dotted.has(`${iface}.${member}`) || (isDistinctive(member) && properties.has(member))) {
				findings.push({ kind: 'api', feature: `${iface}.${member}`, misses })
			}
		}
	}

	for (const [namespace, entry] of Object.entries(bcd.javascript.builtins)) {
		for (const [member, node] of Object.entries(entry)) {
			if (member.startsWith('__')) continue
			if (!dotted.has(`${namespace}.${member}`)) continue
			const misses = missesFloor((node as { __compat?: CompatStatement }).__compat)
			if (misses) findings.push({ kind: 'builtin', feature: `${namespace}.${member}`, misses })
		}
	}
	return findings
}

function scanCss(): Finding[] {
	const findings = new Map<string, Finding>()
	const record = (kind: string, feature: string, misses: string[] | null) => {
		if (misses) findings.set(`${kind}:${feature}`, { kind: `css:${kind}`, feature, misses })
	}

	for (const { code } of readAssets('.css')) {
		const root = postcss.parse(code)
		root.walkDecls((decl) => {
			// a prefixed property is BCD's unprefixed entry with a prefix on the support statement, and asking
			// whether -webkit-foo is supported unprefixed answers a question nobody asked
			const prop = decl.prop.toLowerCase()
			if (prop.startsWith('--') || prop.startsWith('-moz-') || prop.startsWith('-ms-')) return
			record('property', prop, missesFloor(bcd.css.properties[prop]?.__compat))
		})
		root.walkAtRules((at) => record('at-rule', `@${at.name}`, missesFloor(bcd.css['at-rules'][at.name]?.__compat)))
		root.walkRules((rule) => {
			for (const selector of rule.selectors) {
				for (const match of selector.matchAll(/::?-?[a-zA-Z][a-zA-Z-]*/g)) {
					const name = match[0].replace(/^::?/, '')
					record('selector', match[0], missesFloor(bcd.css.selectors[name]?.__compat))
				}
			}
		})
	}
	return [...findings.values()]
}

const floors = Object.entries(BROWSER_FLOOR)
	.map(([b, v]) => `${b} ${v}`)
	.join(', ')
const all = [...scanJs(), ...scanCss()].sort((a, b) => a.feature.localeCompare(b.feature))
const key = (f: Finding) => (f.kind.startsWith('css:') ? `css:${f.kind.slice(4)}:${f.feature}` : f.feature)

if (process.argv.includes('--all')) {
	for (const f of all) console.log(`  [${f.kind}] ${f.feature}  -- ${f.misses.join(', ')}${key(f) in ALLOWED ? '  (allowed)' : ''}`)
	process.exit(0)
}

const unexplained = all.filter((f) => !(key(f) in ALLOWED))
const stale = Object.keys(ALLOWED).filter((k) => !all.some((f) => key(f) === k))

for (const f of unexplained) console.log(`  [${f.kind}] ${f.feature}  -- ${f.misses.join(', ')}`)
if (stale.length) {
	console.log(`\n${stale.length} entr(ies) in ALLOWED no longer appear in the bundle; drop them:`)
	for (const k of stale) console.log(`  ${k}`)
}

if (unexplained.length) {
	console.log(
		`\n${unexplained.length} feature(s) in the built client are missing from a browser we support (${floors}).` +
			`\nCheck each one, then either fix it or add it to ALLOWED in ${import.meta.filename.split('/').slice(-3).join('/')} with the reason.`,
	)
	process.exit(1)
}
if (stale.length) process.exit(1)
console.log(`${all.length} known-partial feature(s) in the built client, all accounted for (${floors})`)
