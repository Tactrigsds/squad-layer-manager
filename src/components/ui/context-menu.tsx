import * as ContextMenuPrimitive from '@radix-ui/react-context-menu'
import { CheckIcon, ChevronRightIcon, DotFilledIcon } from '@radix-ui/react-icons'
import * as React from 'react'

import { cn } from '@/lib/utils'
import { BaseZIndexContext, useZIndex, ZI_OFFSETS } from '@/models/zindex'
import * as WarnChat from '@/systems/warn-chat.client'

const ContextMenu = ContextMenuPrimitive.Root

const ContextMenuTrigger = ContextMenuPrimitive.Trigger

const ContextMenuGroup = ContextMenuPrimitive.Group

const ContextMenuPortal = ContextMenuPrimitive.Portal

const ContextMenuSub = ContextMenuPrimitive.Sub

const ContextMenuRadioGroup = ContextMenuPrimitive.RadioGroup

const ContextMenuSubTrigger = React.forwardRef<
	React.ElementRef<typeof ContextMenuPrimitive.SubTrigger>,
	React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubTrigger> & {
		inset?: boolean
	}
>(({ className, inset, children, ...props }, ref) => (
	<ContextMenuPrimitive.SubTrigger ref={ref} className={cn('fd-mi', inset && 'pl-7', className)} {...props}>
		{children}
		<ChevronRightIcon className="ml-auto" />
	</ContextMenuPrimitive.SubTrigger>
))
ContextMenuSubTrigger.displayName = ContextMenuPrimitive.SubTrigger.displayName

const ContextMenuSubContent = React.forwardRef<
	React.ElementRef<typeof ContextMenuPrimitive.SubContent>,
	React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubContent>
>(({ className, style, children, ...props }, ref) => {
	const zIndex = useZIndex(ZI_OFFSETS.POPOVER)
	return (
		<ContextMenuPrimitive.SubContent
			ref={ref}
			className={cn(
				'fd-menu min-w-40 max-w-[calc(100vw-16px)] max-h-(--radix-context-menu-content-available-height) overflow-y-auto',
				className,
			)}
			style={{ zIndex, ...style }}
			{...props}
		>
			<BaseZIndexContext.Provider value={zIndex}>{children}</BaseZIndexContext.Provider>
		</ContextMenuPrimitive.SubContent>
	)
})
ContextMenuSubContent.displayName = ContextMenuPrimitive.SubContent.displayName

const ContextMenuContent = React.forwardRef<
	React.ElementRef<typeof ContextMenuPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>
>(({ className, style, onCloseAutoFocus, children, ...props }, ref) => {
	const zIndex = useZIndex(ZI_OFFSETS.POPOVER)

	return (
		<ContextMenuPrimitive.Portal>
			<ContextMenuPrimitive.Content
				ref={ref}
				// when a menu item just handed focus to a warn box: (1) don't let the closing menu restore focus
				// to its trigger, and (2) re-fire the focus now that the menu's focus trap has been released,
				// since focusing while the trap was still mounted (during the exit animation) doesn't stick.
				onCloseAutoFocus={(e) => {
					if (WarnChat.warnFocusJustRequested()) {
						e.preventDefault()
						WarnChat.refireWarnFocus()
					}
					onCloseAutoFocus?.(e)
				}}
				className={cn(
					'fd-menu min-w-40 max-w-[calc(100vw-16px)] max-h-(--radix-context-menu-content-available-height) overflow-y-auto',
					className,
				)}
				style={{ zIndex, ...style }}
				{...props}
			>
				<BaseZIndexContext.Provider value={zIndex}>{children}</BaseZIndexContext.Provider>
			</ContextMenuPrimitive.Content>
		</ContextMenuPrimitive.Portal>
	)
})
ContextMenuContent.displayName = ContextMenuPrimitive.Content.displayName

const ContextMenuItem = React.forwardRef<
	React.ElementRef<typeof ContextMenuPrimitive.Item>,
	React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> & {
		inset?: boolean
	}
>(({ className, inset, ...props }, ref) => (
	<ContextMenuPrimitive.Item ref={ref} className={cn('fd-mi relative', inset && 'pl-7', className)} {...props} />
))
ContextMenuItem.displayName = ContextMenuPrimitive.Item.displayName

const ContextMenuCheckboxItem = React.forwardRef<
	React.ElementRef<typeof ContextMenuPrimitive.CheckboxItem>,
	React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.CheckboxItem>
>(({ className, children, checked, ...props }, ref) => (
	<ContextMenuPrimitive.CheckboxItem ref={ref} className={cn('fd-mi relative pl-7', className)} checked={checked} {...props}>
		<span className="absolute left-1.5 flex h-3.5 w-3.5 items-center justify-center text-pri-hi">
			<ContextMenuPrimitive.ItemIndicator>
				<CheckIcon className="h-4 w-4" />
			</ContextMenuPrimitive.ItemIndicator>
		</span>
		{children}
	</ContextMenuPrimitive.CheckboxItem>
))
ContextMenuCheckboxItem.displayName = ContextMenuPrimitive.CheckboxItem.displayName

const ContextMenuRadioItem = React.forwardRef<
	React.ElementRef<typeof ContextMenuPrimitive.RadioItem>,
	React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.RadioItem>
>(({ className, children, ...props }, ref) => (
	<ContextMenuPrimitive.RadioItem ref={ref} className={cn('fd-mi relative pl-7', className)} {...props}>
		<span className="absolute left-1.5 flex h-3.5 w-3.5 items-center justify-center text-pri-hi">
			<ContextMenuPrimitive.ItemIndicator>
				<DotFilledIcon className="h-4 w-4 fill-current" />
			</ContextMenuPrimitive.ItemIndicator>
		</span>
		{children}
	</ContextMenuPrimitive.RadioItem>
))
ContextMenuRadioItem.displayName = ContextMenuPrimitive.RadioItem.displayName

const ContextMenuLabel = React.forwardRef<
	React.ElementRef<typeof ContextMenuPrimitive.Label>,
	React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Label> & {
		inset?: boolean
	}
>(({ className, inset, ...props }, ref) => (
	<ContextMenuPrimitive.Label ref={ref} className={cn('fd-mlabel', inset && 'pl-7', className)} {...props} />
))
ContextMenuLabel.displayName = ContextMenuPrimitive.Label.displayName

const ContextMenuSeparator = React.forwardRef<
	React.ElementRef<typeof ContextMenuPrimitive.Separator>,
	React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>
>(({ className, ...props }, ref) => <ContextMenuPrimitive.Separator ref={ref} className={cn('fd-msep', className)} {...props} />)
ContextMenuSeparator.displayName = ContextMenuPrimitive.Separator.displayName

const ContextMenuShortcut = ({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) => {
	return <span className={cn('fd-mi-sc', className)} {...props} />
}
ContextMenuShortcut.displayName = 'ContextMenuShortcut'

export {
	ContextMenu,
	ContextMenuCheckboxItem,
	ContextMenuContent,
	ContextMenuGroup,
	ContextMenuItem,
	ContextMenuLabel,
	ContextMenuPortal,
	ContextMenuRadioGroup,
	ContextMenuRadioItem,
	ContextMenuSeparator,
	ContextMenuShortcut,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
	ContextMenuTrigger,
}
