import * as PopoverPrimitive from '@radix-ui/react-popover'
import type React from 'react'

import { BottomSheetFrame } from '@/components/ui/bottom-sheet'
import { PopoverContent } from '@/components/ui/popover.tsx'
import * as KBClient from '@/systems/keybinds.client'

import { useIsComboBoxSheet } from './sheet.ts'

// the open panel of a combo box: a popover anchored to the trigger, or on a phone a sheet (see sheet.ts)
export function ComboBoxSurface(props: {
	title: string
	onClose: () => void
	popoverProps: React.ComponentProps<typeof PopoverContent>
	children: React.ReactNode
}) {
	const sheet = useIsComboBoxSheet()
	const kbScope = KBClient.useScope('combo-box', {})
	if (!sheet)
		return (
			<PopoverContent kbScope={kbScope} {...props.popoverProps}>
				{props.children}
			</PopoverContent>
		)
	// the scrim sits outside the sheet, so useComboBoxDismissal reads a tap on it as an outside pointerdown
	return (
		<PopoverPrimitive.Portal>
			<BottomSheetFrame title={props.title} onClose={props.onClose} closeOnScrim={false} data-combobox-sheet="">
				{props.children}
			</BottomSheetFrame>
		</PopoverPrimitive.Portal>
	)
}
