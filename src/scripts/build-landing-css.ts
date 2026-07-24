import * as Paths from '$root/paths'
import { compileLandingCss } from '@/systems/landing-css'
import * as fs from 'node:fs'
import * as path from 'node:path'

// Prebuilds the landing/403 pages' inline stylesheet for the bundled prod server, which has no Tailwind at
// runtime. Runs after `build:client` (so it survives vite emptying dist/) and ships dist/landing.css in the image.

const OUT = path.join(Paths.DIST, 'landing.css')

async function main() {
	const css = await compileLandingCss()
	fs.mkdirSync(Paths.DIST, { recursive: true })
	fs.writeFileSync(OUT, css)
	console.log(`wrote ${OUT} (${css.length} bytes)`)
}

await main()
