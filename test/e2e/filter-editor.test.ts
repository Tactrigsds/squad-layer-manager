import * as FB from '@/models/filter-builders'

import { type AppFixture, createAppFixture } from '../harness/app-fixture'
import { filter, LAYERS, queue } from '../harness/arrange'
import { expect, test } from './fixtures'

// The filter pages, against one app: the entity form (the only tanstack-form surface, so where a
// form-library upgrade breaks first), the reference graph a filter cannot be deleted out of, and the
// cycle refusal. The tests read the seeded graph before they mutate it: the reference assertions run
// before the rename, and the cycle test leaves its unsaved edit to die with the page.

let app: AppFixture

test.beforeAll(async () => {
	app = await createAppFixture({
		layerQueue: queue(LAYERS.harjuRaas),
		filters: [
			filter('raas-only', 'RAAS Only', FB.and([FB.eq('Gamemode', 'RAAS')])),
			filter('raas-harju', 'RAAS on Harju', FB.and([FB.includedIn('raas-only'), FB.eq('Map', 'Harju')])),
			// named so it sorts first alphabetically: the pool filter has to jump ahead of it on its own merit
			filter('unused', 'AAS Only', FB.and([FB.eq('Gamemode', 'AAS')])),
			// its own filter, because the text-mode test runs after `unused` has been deleted out from under it
			filter('text-mode', 'Text Mode', FB.and([FB.eq('Gamemode', 'AAS')])),
		],
		serverSettings: (settings) => {
			settings.queue.mainPool.poolFilter = { filterId: 'raas-harju', mode: 'include' }
		},
	})
})

test.afterAll(async () => {
	await app?.dispose()
})

test.describe('the filter editor form', { tag: '@firefox' }, () => {
	test('rejects a malformed id with the schema message, and recovers once it is valid', async ({ page }) => {
		await page.goto(app.loginUrl(app.adminUser, '/filters/new'))

		const id = page.getByRole('textbox', { name: 'ID' })
		await expect(id).toBeVisible({ timeout: 20_000 })
		await id.fill('Not A Valid Id!!')

		// the schema's own message has to survive to the screen: a validation error the user cannot read
		// is the same as no validation at all
		const error = page.getByRole('alert').filter({ hasText: 'ID:' })
		await expect(error).toContainText('Must contain only lowercase letters, numbers, hyphens, and underscores')
		await expect(error).not.toContainText('[object Object]')

		await id.fill('a-valid-id')
		await expect(error).toBeHidden()
	})

	test('derives the id from the name until the id is edited directly', async ({ page }) => {
		await page.goto(app.loginUrl(app.adminUser, '/filters/new'))

		const name = page.getByRole('textbox', { name: 'Name' })
		const id = page.getByRole('textbox', { name: 'ID' })
		await expect(name).toBeVisible({ timeout: 20_000 })

		await name.fill('Armored Layers')
		await expect(id).toHaveValue('armored-layers')

		// once the id is the user's own, the name must stop overwriting it
		await id.fill('custom-id')
		await name.fill('Armored Layers Revised')
		await expect(id).toHaveValue('custom-id')
	})
})

// Deleting a filter something still points at would leave the pool, or another filter, referring to nothing.
// The gate is server-side; what these cover is that the page tells the user what is holding the filter and
// stops offering the delete.
test.describe('filter references', () => {
	test('lists what references a filter and refuses to delete it until nothing does', async ({ page }) => {
		await page.goto(app.loginUrl(app.adminUser, '/filters/raas-only'))

		const references = page.getByRole('region', { name: 'References' })
		await expect(references).toContainText('2 references', { timeout: 20_000 })
		// referenced directly by raas-harju, and transitively by the pool filter that applies it
		await expect(references).toContainText('RAAS on Harju')
		await expect(references).toContainText('Pool filter')
		await expect(references).toContainText('via raas-harju')

		await expect(page.getByRole('button', { name: 'Delete' })).toBeDisabled()

		// the filter the pool names directly says so on its own line, rather than among the other pool uses
		await page.goto(app.loginUrl(app.adminUser, '/filters/raas-harju'))
		await expect(references.getByText('Pool filter for:')).toBeVisible({ timeout: 20_000 })

		// and it leads the index, ahead of the alphabetically earlier filters, saying which server it is for
		await page.goto(app.loginUrl(app.adminUser, '/filters'))
		const leadCard = page.getByRole('listitem').first()
		await expect(leadCard).toContainText('RAAS on Harju', { timeout: 20_000 })
		await expect(leadCard).toContainText('Pool filter for:')
		await expect(leadCard).toContainText('Emulated Server')

		// a filter nothing points at still deletes
		await page.goto(app.loginUrl(app.adminUser, '/filters/unused'))
		await expect(page.getByText('Nothing references this filter')).toBeVisible({ timeout: 20_000 })
		await page.getByRole('button', { name: 'Delete' }).click()
		await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click()

		await app.waitFor(
			() => {
				const row = app.readDb().prepare('select id from filters where id = ?').get('unused')
				return row ? null : true
			},
			{ label: 'unreferenced filter deleted' },
		)
	})

	test('navigating between filters via reference badges leaves the editor pristine', async ({ page }) => {
		await page.goto(app.loginUrl(app.adminUser, '/filters/raas-only'))

		const references = page.getByRole('region', { name: 'References' })
		await references.getByRole('link').filter({ hasText: 'RAAS on Harju' }).click({ timeout: 20_000 })
		await page.waitForURL('**/filters/raas-harju*')
		await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled({ timeout: 20_000 })

		// returning serves the first filter from the router's cache, the other way this route re-enters
		// without a remount. The editor must come back pristine: same tree, save gated, nothing to warn about
		await page.goBack()
		await page.waitForURL('**/filters/raas-only*')
		// a leaked tree from raas-harju would close a reference loop here, so the cycle alert doubles as the
		// poison detector. It arrives asynchronously (debounced editor sync + validation), so settle first
		await page.waitForTimeout(1_000)
		await expect(page.getByRole('alert').filter({ hasText: 'raas-only ->' })).toHaveCount(0)
		await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled()

		// a leftover dirty flag would put a confirm dialog in the way of this navigation and time it out
		await page.getByRole('link', { name: 'Filters', exact: true }).click()
		await page.waitForURL('**/filters')
	})

	test('refuses to save an edit that would make two filters reference each other', async ({ page }) => {
		await page.goto(app.loginUrl(app.adminUser, '/filters/raas-only'))

		// the editor is only live once its first validation has run, which is what constrains the layer table to
		// the filter. Editing before that races the frame's setup, and the loop check would silently not run.
		// The positive wait comes first: the absence check passes vacuously while the table has no rows at all.
		await expect(page.getByRole('row').filter({ hasText: /RAAS/ }).first()).toBeVisible({ timeout: 20_000 })
		await expect(page.getByRole('row').filter({ hasText: 'Skirmish' })).toHaveCount(0)

		await page.getByRole('button', { name: 'Add condition' }).first().click({ timeout: 20_000 })
		// a freshly added apply-filter node opens its picker itself, so clicking it here would close it
		await page.getByRole('button', { name: 'apply existing filter' }).click()
		await page.getByRole('option', { name: 'RAAS on Harju' }).click()

		await expect(page.getByRole('alert')).toContainText('raas-only -> raas-harju -> raas-only')
		await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled()
	})

	// last on purpose: this save races the tree editor's hydration, and a save that lands before the
	// tree is live can clobber the filter for anything that reads it afterwards
	test('saves an edited name back to the filter', async ({ page }) => {
		await page.goto(app.loginUrl(app.adminUser, '/filters/raas-only'))

		// the entity fields are behind the details toggle; the tree is what the page opens on
		await page.getByRole('button', { name: 'Edit Details' }).click()

		const name = page.getByRole('textbox', { name: 'Name' })
		await expect(name).toHaveValue('RAAS Only')
		await name.fill('RAAS Only (renamed)')

		await page.getByRole('button', { name: 'Save' }).click()

		await app.waitFor(
			() => {
				const row = app.readDb().prepare('select name from filters where id = ?').get('raas-only') as { name: string } | undefined
				return row?.name === 'RAAS Only (renamed)' ? row : null
			},
			{ label: 'renamed filter persisted' },
		)
	})
})

// A vehicle picker narrows by two groupings at once. Collection tabs, because there are a handful; the
// vehicle classes are too many to tab through and drill in instead. Runs against a new filter, so it owns
// no seeded state and cannot disturb anything above it.
test.describe('option groupings', () => {
	test('narrows a vehicle picker by collection and class together', async ({ page }) => {
		await page.goto(app.loginUrl(app.adminUser, '/filters/new'))
		const addCondition = page.getByRole('button', { name: 'Add condition' }).first()
		await expect(addCondition).toBeVisible({ timeout: 20_000 })

		await addCondition.click()
		await page.getByRole('button', { name: 'faction/unit' }).click()
		// the blank comparison opens its own column picker, and picking a column hands focus on to the value
		// picker, which opens itself in turn -- clicking either trigger here would close it
		await page.getByRole('option', { name: 'Vehicle T1', exact: true }).click()

		const picker = page.getByRole('dialog').filter({ hasText: 'Selected Vehicle T1s' })
		const facet = picker.getByRole('button', { name: 'Narrow by Vehicle type' })
		await expect(facet).toHaveText(/Vehicle type:\s*All/)
		await expect(picker.getByRole('tab', { name: 'OWI' })).toBeVisible()

		await facet.click()
		// each class carries the count it would leave, so a dead end shows before it is taken
		await picker.getByRole('option', { name: /Tracked IFV/ }).click()
		await expect(facet).toHaveText(/Vehicle type:\s*Tracked IFV/)

		await expect(picker.getByRole('option', { name: 'BMP-2', exact: true })).toBeVisible()
		await expect(picker.getByRole('option', { name: 'M1A1', exact: true })).toHaveCount(0)
		// a SuperMod tracked IFV: present under every collection, gone once the collection tab narrows too
		await expect(picker.getByRole('option', { name: /Marder 1A3/ })).toBeVisible()

		await picker.getByRole('tab', { name: 'OWI' }).click()
		await expect(picker.getByRole('option', { name: 'BMP-2', exact: true })).toBeVisible()
		await expect(picker.getByRole('option', { name: /Marder 1A3/ })).toHaveCount(0)

		// escape backs out of the drill-in rather than closing the picker out from under it
		await facet.click()
		await expect(picker.getByRole('button', { name: 'Back to options' })).toBeVisible()
		await page.keyboard.press('Escape')
		await expect(facet).toBeVisible()
		await expect(picker.getByRole('option', { name: 'BMP-2', exact: true })).toBeVisible()
	})
})

// The builder stays mounted behind the text tab, so it re-renders on every keystroke the text editor accepts.
// A column name is free-form text, which means a half-typed one is a schema-valid filter the builder has to
// survive; it used to reach an enum lookup keyed on the closed column set and take the whole page down.
test.describe('the filter text editor', () => {
	test('a column name that resolves to nothing does not take the page down', async ({ page }) => {
		await page.goto(app.loginUrl(app.adminUser, '/filters/text-mode'))
		await page.getByRole('button', { name: 'Text', exact: true }).click()

		const editor = page.locator('.cm-content')
		await expect(editor).toContainText('Gamemode', { timeout: 20_000 })
		await editor.fill(
			'type: and\nchildren: [ { type: eq, neg: false, args: [ { type: column, column: Gamemod }, { type: value, value: AAS } ] } ]',
		)
		await expect(editor).toContainText('Gamemod')

		await page.getByRole('button', { name: 'Builder', exact: true }).click()
		await expect(page.getByText('This page failed')).toHaveCount(0)
		// the column keeps its own name in the picker, and the value editor beside it offers nothing to pick
		await expect(page.getByRole('combobox', { name: 'Column' })).toContainText('Gamemod')
	})
})
