import type { Locator, Page } from '@playwright/test'

// Dragging with dnd-kit through synthetic pointer events. dnd-kit re-measures its drop targets on animation
// frames, so what commits a drop is not the pointer being over the target, it is the pointer having been there
// long enough for dnd-kit to have seen it. A move-then-release inside one frame drops on whatever the previous
// frame measured, which in this app's panels is usually nothing: the queue's drop separators only expand once a
// drag has started, so the frame before the drop is the one where the target did not exist yet.
//
// Chromium hides this, landing frames between playwright's events often enough that the drop is already
// measured by the time the button comes up. Firefox does not, and a drag written without these waits fails
// there while passing in chromium at any timeout.
//
// The waits are counted in frames rather than milliseconds because a fixed sleep is a bet that the browser
// painted within it, and that bet loses exactly when several workers are competing for the machine.
const SETTLE_FRAMES = 3

async function settle(page: Page, frames = SETTLE_FRAMES) {
	await page.evaluate(
		(n) =>
			new Promise<void>((resolve) => {
				const tick = (remaining: number) => {
					if (remaining <= 0) {
						resolve()
						return
					}
					requestAnimationFrame(() => tick(remaining - 1))
				}
				tick(n)
			}),
		frames,
	)
}

// Starts a drag from `grip` and drops it on the point `measureTarget` returns. The first small move is what
// crosses dnd-kit's activation distance, and it has to happen before the caller measures the target: starting
// the drag is what expands the drop zones, and their rects are only final afterwards.
export async function dragFrom(page: Page, grip: Locator, measureTarget: () => Promise<{ x: number; y: number }>) {
	const gripBox = await grip.boundingBox()
	if (!gripBox) throw new Error('drag grip is not visible')

	await grip.hover()
	await page.mouse.down()
	await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + 20, { steps: 4 })
	await settle(page)

	const target = await measureTarget()
	await page.mouse.move(target.x, target.y, { steps: 20 })
	await settle(page)
	// one more pointer event a pixel on, now that the frames above have let dnd-kit measure this position: it is
	// what the drop is attributed to, instead of the move that arrived before the measurement
	await page.mouse.move(target.x, target.y + 1, { steps: 2 })
	await settle(page)
	await page.mouse.up()
}

// The drop separator below a list item: dnd-kit's own gap, which only has a hit area during a drag.
export async function belowItem(item: Locator) {
	const box = await item.boundingBox()
	if (!box) throw new Error('drop target is not visible')
	return { x: box.x + box.width / 2, y: box.y + box.height + 8 }
}

export async function centerOf(target: Locator, offsetY = 0) {
	const box = await target.boundingBox()
	if (!box) throw new Error('drop target is not visible')
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 + offsetY }
}
