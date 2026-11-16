import type { Page } from '@playwright/test'

// Picks an option from the open combo box. A long option list mounts only the rows in view, so the option is
// searched for first to bring it into the page.
export async function pickOption(page: Page, name: string) {
	await page.locator('[cmdk-input]').fill(name)
	await page.getByRole('option', { name, exact: true }).click()
}
