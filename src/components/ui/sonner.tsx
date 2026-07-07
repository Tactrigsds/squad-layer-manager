import * as ThemeClient from '@/systems/theme.client'
import type { CSSProperties } from 'react'
import { Toaster as Sonner, type ToasterProps } from 'sonner'

function Toaster(props: ToasterProps) {
	const { resolvedTheme } = ThemeClient.useTheme()

	return (
		<Sonner
			theme={resolvedTheme}
			className="toaster group"
			style={{
				'--normal-bg': 'hsl(var(--popover))',
				'--normal-text': 'hsl(var(--popover-foreground))',
				'--normal-border': 'hsl(var(--border))',
			} as CSSProperties}
			{...props}
		/>
	)
}

export { Toaster }
