// Drives this workspace's running `pnpm dev` instance with headless chromium, for checking a UI change without the
// Chrome extension. Signed in as the workspace's dev user. Page errors and console errors are printed with their
// stacks. Runs inside the optional nix dev shell when there is one (see nix-shell.mjs).
//
//   pnpm probe /servers/emulator --shot out.jpg                  viewport screenshot
//   pnpm probe /servers/emulator --shot out.jpg --target 'main'   screenshot of one element
//   pnpm probe / --click 'role=button[name="Add Layers"]' --eval 'document.title'
//   pnpm probe / --script steps.mjs                               export default async ({ page }) => ...
//
// --click and --fill (selector=value) repeat and run in the order given, before --eval, --script and --shot.
// Screenshots are JPEG at quality 60 unless the path ends in .png, to keep them cheap to read back.
//
// A --script's return value is printed as JSON. A page.goto inside a --script never fires `load`, because the SPA
// navigates client-side, so probe one route per run and pass it as the path. Inside page.evaluate,
// `await import('/src/orpc.client.ts')` returns the app's RPC client, and any other dev module imports the same way.
// After an HMR update the app holds the module at a `?t=` URL (see performance.getEntriesByType('resource')), and a
// plain `/src/...` import is a separate instance. --width alone keeps `pointer: fine`; for a touch phone, open a
// context with `isMobile: true, hasTouch: true` from the script.

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import { reexecInFlake, repoRoot } from './nix-shell.mjs'

reexecInFlake(import.meta.url)

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		shot: { type: 'string' },
		target: { type: 'string' },
		click: { type: 'string', multiple: true },
		fill: { type: 'string', multiple: true },
		eval: { type: 'string' },
		script: { type: 'string' },
		width: { type: 'string', default: '1600' },
		height: { type: 'string', default: '900' },
		wait: { type: 'string', default: '1000' },
	},
})

const base = new URL(
	execFileSync('pnpm', ['-s', 'dev', '--url'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(),
)
const url = new URL(positionals[0] ?? '/', base)
url.search = base.search

const { chromium } = createRequire(path.join(repoRoot, 'package.json'))('@playwright/test')
const browser = await chromium.launch()
let failed = false
try {
	const page = await browser.newPage({ viewport: { width: Number(values.width), height: Number(values.height) } })
	page.on('pageerror', (err) => console.log(`PAGE ERROR: ${err.stack ?? err.message}`))
	page.on('console', (msg) => {
		if (msg.type() === 'error') console.log(`CONSOLE ERROR: ${msg.text()}`)
	})
	await page.goto(url.href, { waitUntil: 'load' })
	await page.waitForTimeout(Number(values.wait))
	// a user's first visit to a page offers its tutorials in a modal that eats pointer events
	if (await page.getByRole('dialog').first().isVisible()) await page.keyboard.press('Escape')

	const steps = process.argv
		.slice(2)
		.flatMap((arg, i, all) => (arg === '--click' || arg === '--fill' ? [{ kind: arg.slice(2), value: all[i + 1] }] : []))
	for (const step of steps) {
		if (step.kind === 'click') {
			await page.locator(step.value).first().click()
		} else {
			const at = step.value.lastIndexOf('=')
			await page
				.locator(step.value.slice(0, at))
				.first()
				.fill(step.value.slice(at + 1))
		}
		await page.waitForTimeout(300)
	}

	if (values.eval) console.log(JSON.stringify(await page.evaluate(values.eval), null, 2))
	if (values.script) {
		const mod = await import(pathToFileURL(path.resolve(values.script)).href)
		const result = await mod.default({ page, url })
		if (result !== undefined) console.log(JSON.stringify(result, null, 2))
	}
	if (values.shot) {
		const opts = values.shot.endsWith('.png') ? { path: values.shot } : { path: values.shot, type: 'jpeg', quality: 60 }
		if (values.target) await page.locator(values.target).first().screenshot(opts)
		else await page.screenshot(opts)
		console.log(`wrote ${values.shot}`)
	}
} catch (err) {
	failed = true
	console.error(err)
} finally {
	await browser.close()
}
process.exit(failed ? 1 : 0)
