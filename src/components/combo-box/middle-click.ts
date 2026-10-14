import type React from 'react'

import * as UI_Msgs from '@/messages/ui.messages'
import { tr } from '@/systems/messages.client'

// trigger props that empty the selection on middle-click; undefined when emptying isn't allowed. A custom trigger's
// own title overrides the hint, since Slot lets the child's props win.
export function clearOnMiddleClickProps(
	clear: (() => void) | undefined,
): Pick<React.HTMLAttributes<HTMLElement>, 'title' | 'onMouseDown' | 'onAuxClick'> {
	if (!clear) return {}
	return {
		title: tr.text(UI_Msgs.middleClickClear()),
		// prevent middle-click autoscroll
		onMouseDown: (e) => {
			if (e.button === 1) e.preventDefault()
		},
		onAuxClick: (e) => {
			if (e.button !== 1) return
			e.preventDefault()
			clear()
		},
	}
}
