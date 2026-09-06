import { expect, type Locator, type Page } from '@playwright/test'

// The dashboard shows the queue and the teams either behind tabs or one above the other, whichever the window
// has room for (see useStackWhenItFits). A test that reaches for a tab is therefore asking about the layout
// rather than about the section it wanted, and gets whichever one the window happened to produce. Both
// layouts name the two sections the same way, and everything here goes through that name.

const DEFAULT_TIMEOUT_MS = 25_000

function section(page: Page, name: RegExp): Locator {
	return page.getByRole('tabpanel', { name }).or(page.getByRole('region', { name }))
}

export const queueSection = (page: Page) => section(page, /^Queue/)
export const teamsSection = (page: Page) => section(page, /^Teams/)

// The label carrying a section's count: the tab in one layout, the section's own title in the other. Tests
// wait on this to know the dashboard has the queue it expects, which is why it takes the full name.
function label(page: Page, name: RegExp | string): Locator {
	return page.getByRole('tab', { name }).or(page.getByRole('heading', { name }))
}

export const queueLabel = (page: Page, name: RegExp | string = /^Queue/) => label(page, name)
export const teamsLabel = (page: Page, name: RegExp | string = /^Teams/) => label(page, name)

// Brings the teams on screen: a click when there is a tab to click, nothing to do when both sections are
// already shown. Waits for the section either way, so it is also the "the roster has arrived" signal.
export async function showTeams(page: Page, opts?: { timeout?: number }) {
	const timeout = opts?.timeout ?? DEFAULT_TIMEOUT_MS
	const tab = page.getByRole('tab', { name: /^Teams/ })
	await expect(teamsSection(page)).toBeAttached({ timeout })
	if ((await tab.count()) > 0) await tab.click({ timeout })
	await expect(teamsSection(page)).toBeVisible({ timeout })
}

// The queue counterpart, for the tests that switch back to it.
export async function showQueue(page: Page, opts?: { timeout?: number }) {
	const timeout = opts?.timeout ?? DEFAULT_TIMEOUT_MS
	const tab = page.getByRole('tab', { name: /^Queue/ })
	await expect(queueSection(page)).toBeAttached({ timeout })
	if ((await tab.count()) > 0) await tab.click({ timeout })
	await expect(queueSection(page)).toBeVisible({ timeout })
}
