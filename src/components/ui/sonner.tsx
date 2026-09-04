import type { CSSProperties } from 'react'
import { Toaster as Sonner, type ToasterProps } from 'sonner'

import * as ThemeClient from '@/systems/theme.client'

function Toaster(props: ToasterProps) {
	const { resolvedTheme } = ThemeClient.useTheme()

	return (
		<Sonner
			theme={resolvedTheme}
			className="toaster group"
			style={
				{
					'--normal-bg': 'var(--panel-hi)',
					'--normal-text': 'var(--text)',
					'--normal-border': 'var(--line)',
					'--border-radius': '3px',
				} as CSSProperties
			}
			{...props}
		/>
	)
}

export { Toaster }
