import * as Browser from '@/lib/browser'

// On a phone a combo box opens as a sheet along the bottom of the screen rather than a popover anchored to its
// trigger. An anchored popover has room for a few rows once the on-screen keyboard is up, and none for the
// description box beside it, so the sheet lists descriptions inline instead.
export function useIsComboBoxSheet() {
	return Browser.useIsSmallViewport()
}
