import * as Paths from '$root/paths'
import tailwindcss from '@tailwindcss/postcss'
import * as fs from 'node:fs'
import * as path from 'node:path'
import postcss from 'postcss'

// Compiles the landing/403 pages' scoped Tailwind sheet (src/landing.css, sourced only from landing-pages.tsx).
// Small enough to inline into the cached HTML. Tailwind is a devDependency and absent from the bundled prod
// server, so this only runs where the app runs from source (dev/test, via tsx); prod reads the prebuilt sheet
// (src/scripts/build-landing-css.ts writes dist/landing.css into the image).

const LANDING_CSS = path.join(Paths.PROJECT_ROOT, 'src/landing.css')

export async function compileLandingCss(): Promise<string> {
	const source = fs.readFileSync(LANDING_CSS, 'utf8')
	const result = await postcss([tailwindcss()]).process(source, { from: LANDING_CSS })
	return result.css
}
