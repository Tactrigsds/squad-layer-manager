// The oldest browser the client is expected to work in. `pnpm check:compat` reads this to decide whether a
// feature in the built bundle is safe, and vite lowers syntax to it.
//
// These are tailwind 4's own floor. Below it the stylesheet the build emits does not work at all, so nothing is
// gained by claiming support for anything older. Firefox 128 is an ESR, which is what makes it the interesting
// number: it is well behind the release channel, and it is what a locked-down desktop is likely to be running.
export const BROWSER_FLOOR = {
	chrome: '111',
	firefox: '128',
	safari: '16.4',
} as const

// vite/oxc spell the same thing as one token per browser
export const BUILD_TARGET = Object.entries(BROWSER_FLOOR).map(([browser, version]) => `${browser}${version}`)
