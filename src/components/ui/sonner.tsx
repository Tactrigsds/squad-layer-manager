import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Toaster as Sonner, type ToasterProps } from 'sonner'

import { TOASTER_HOST_ID } from '@/lib/toast'
import { useZIndex, ZI_OFFSETS } from '@/models/zindex.models'
import * as ThemeClient from '@/systems/theme.client'

// Rendered into its own body-level host with pointer events of its own, so a toast stays clickable while a
// dialog is open: a Headless UI dialog marks the React root inert, and a Radix dialog turns pointer events off
// on body.
function Toaster(props: ToasterProps) {
	const { resolvedTheme } = ThemeClient.useTheme()
	const zIndex = useZIndex(ZI_OFFSETS.TOAST)

	return createPortal(
		<Sonner
			theme={resolvedTheme}
			className="toaster group"
			style={
				{
					zIndex,
					pointerEvents: 'auto',
					'--normal-bg': 'var(--panel-hi)',
					'--normal-text': 'var(--text)',
					'--normal-border': 'var(--line)',
					'--border-radius': '3px',
				} as CSSProperties
			}
			{...props}
		/>,
		document.getElementById(TOASTER_HOST_ID)!,
	)
}

export { Toaster }
