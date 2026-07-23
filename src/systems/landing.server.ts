import * as Paths from '$root/paths'
import { LandingDocument } from '@/components/landing-pages'
import * as Env from '@/server/env.ts'
import { initModule } from '@/server/logger'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// Static, no-JS pages served outside the SPA: the login landing at '/' and the 403 shown to authenticated users
// who lack site access. Authored as React components (landing-pages.tsx), rendered to a string once at setup()
// and held, so requests never re-render them. Styling reuses the app's compiled Tailwind sheet: in prod the
// hashed stylesheet vite emitted into dist/index.html, in dev vite's live '/src/index.css'.

const DEFAULT_REPO_URL = 'https://github.com/Tactrigsds/squad-layer-manager'

const FONT_LINKS = [
	{ rel: 'preconnect', href: 'https://fonts.googleapis.com' },
	{ rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: 'anonymous' as const },
	{ rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Roboto+Condensed:ital,wght@0,100..900;1,100..900&display=swap' },
]

const envBuilder = Env.getEnvBuilder({ ...Env.groups.general })
let ENV!: ReturnType<typeof envBuilder>
const module = initModule('landing')

let landingHtmlCache!: string
let forbiddenHtmlCache!: string

export function setup() {
	ENV = envBuilder()
	const repoUrl = ENV.PUBLIC_REPO_URL ?? DEFAULT_REPO_URL
	const assetLinks = [...FONT_LINKS, ...resolveStyleLinks()]
	landingHtmlCache = render('landing', repoUrl, assetLinks)
	forbiddenHtmlCache = render('forbidden', repoUrl, assetLinks)
	module.getLogger().info('landing pages rendered')
}

export function landingHtml() {
	return landingHtmlCache
}

export function forbiddenHtml() {
	return forbiddenHtmlCache
}

function render(variant: 'landing' | 'forbidden', repoUrl: string, assetLinks: { rel: string; href: string }[]) {
	return '<!DOCTYPE html>' + renderToStaticMarkup(createElement(LandingDocument, { variant, repoUrl, assetLinks }))
}

// the SPA's Tailwind bundle already contains the landing-page classes (Tailwind's @source scans every .tsx),
// so the page just links the same stylesheet the app serves.
function resolveStyleLinks(): { rel: string; href: string }[] {
	// ?direct makes vite serve the compiled CSS as text/css; without it a bare /src/index.css is an HMR JS module
	if (ENV.NODE_ENV === 'development') return [{ rel: 'stylesheet', href: '/src/index.css?direct' }]
	const indexHtml = fs.readFileSync(path.join(Paths.DIST, 'index.html'), 'utf8')
	const hrefs = [...indexHtml.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map((m) => m[1])
	return hrefs.map((href) => ({ rel: 'stylesheet', href }))
}
