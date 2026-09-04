import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, DotFilledIcon } from '@radix-ui/react-icons'
import * as React from 'react'

import { cn } from '@/lib/utils'
import { BaseZIndexContext, useZIndex, ZI_OFFSETS } from '@/models/zindex'

const DropdownMenu = DropdownMenuPrimitive.Root

const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger

const DropdownMenuGroup = DropdownMenuPrimitive.Group

const DropdownMenuPortal = DropdownMenuPrimitive.Portal

const DropdownMenuSub = DropdownMenuPrimitive.Sub

const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup

const DropdownMenuSubTrigger = React.forwardRef<
	React.ElementRef<typeof DropdownMenuPrimitive.SubTrigger>,
	React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger> & {
		inset?: boolean
		chevronLeft?: boolean
	}
>(({ className, inset, chevronLeft, children, ...props }, ref) => (
	<DropdownMenuPrimitive.SubTrigger ref={ref} className={cn('fd-mi', inset && 'pl-7', className)} {...props}>
		{chevronLeft && <ChevronLeftIcon />}
		{children}
		{!chevronLeft && <ChevronRightIcon className="ml-auto" />}
	</DropdownMenuPrimitive.SubTrigger>
))
DropdownMenuSubTrigger.displayName = DropdownMenuPrimitive.SubTrigger.displayName

const DropdownMenuSubContent = React.forwardRef<
	React.ElementRef<typeof DropdownMenuPrimitive.SubContent>,
	React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>
>(({ className, style, children, ...props }, ref) => {
	const zIndex = useZIndex(ZI_OFFSETS.POPOVER)
	return (
		<DropdownMenuPrimitive.SubContent
			ref={ref}
			className={cn('fd-menu min-w-32 max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto', className)}
			style={{ zIndex, ...style }}
			{...props}
		>
			<BaseZIndexContext.Provider value={zIndex}>{children}</BaseZIndexContext.Provider>
		</DropdownMenuPrimitive.SubContent>
	)
})
DropdownMenuSubContent.displayName = DropdownMenuPrimitive.SubContent.displayName

const DropdownMenuContent = React.forwardRef<
	React.ElementRef<typeof DropdownMenuPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 4, collisionPadding = 8, style, children, ...props }, ref) => {
	const zIndex = useZIndex(ZI_OFFSETS.POPOVER)

	return (
		<DropdownMenuPrimitive.Portal>
			<DropdownMenuPrimitive.Content
				ref={ref}
				sideOffset={sideOffset}
				collisionPadding={collisionPadding}
				className={cn(
					'fd-menu min-w-40 max-w-[calc(100vw-16px)] max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto',
					className,
				)}
				style={{ zIndex, ...style }}
				{...props}
			>
				<BaseZIndexContext.Provider value={zIndex}>{children}</BaseZIndexContext.Provider>
			</DropdownMenuPrimitive.Content>
		</DropdownMenuPrimitive.Portal>
	)
})
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName

export const dropdownMenuItemClassesBase = 'fd-mi relative'
const DropdownMenuItem = React.forwardRef<
	React.ElementRef<typeof DropdownMenuPrimitive.Item>,
	React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & {
		inset?: boolean
	}
>(({ className, inset, ...props }, ref) => (
	<DropdownMenuPrimitive.Item ref={ref} className={cn(dropdownMenuItemClassesBase, inset && 'pl-7', className)} {...props} />
))
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName

const DropdownMenuCheckboxItem = React.forwardRef<
	React.ElementRef<typeof DropdownMenuPrimitive.CheckboxItem>,
	React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>
>(({ className, children, checked, ...props }, ref) => (
	<DropdownMenuPrimitive.CheckboxItem ref={ref} className={cn('fd-mi relative pl-7', className)} checked={checked} {...props}>
		<span className="absolute left-1.5 flex h-3.5 w-3.5 items-center justify-center text-pri-hi">
			<DropdownMenuPrimitive.ItemIndicator>
				<CheckIcon className="h-4 w-4" />
			</DropdownMenuPrimitive.ItemIndicator>
		</span>
		{children}
	</DropdownMenuPrimitive.CheckboxItem>
))
DropdownMenuCheckboxItem.displayName = DropdownMenuPrimitive.CheckboxItem.displayName

const DropdownMenuRadioItem = React.forwardRef<
	React.ElementRef<typeof DropdownMenuPrimitive.RadioItem>,
	React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem>
>(({ className, children, ...props }, ref) => (
	<DropdownMenuPrimitive.RadioItem ref={ref} className={cn('fd-mi relative pl-7', className)} {...props}>
		<span className="absolute left-1.5 flex h-3.5 w-3.5 items-center justify-center text-pri-hi">
			<DropdownMenuPrimitive.ItemIndicator>
				<DotFilledIcon className="h-4 w-4 fill-current" />
			</DropdownMenuPrimitive.ItemIndicator>
		</span>
		{children}
	</DropdownMenuPrimitive.RadioItem>
))
DropdownMenuRadioItem.displayName = DropdownMenuPrimitive.RadioItem.displayName

const DropdownMenuLabel = React.forwardRef<
	React.ElementRef<typeof DropdownMenuPrimitive.Label>,
	React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label> & {
		inset?: boolean
	}
>(({ className, inset, ...props }, ref) => (
	<DropdownMenuPrimitive.Label ref={ref} className={cn('fd-mlabel', inset && 'pl-7', className)} {...props} />
))
DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName

const DropdownMenuSeparator = React.forwardRef<
	React.ElementRef<typeof DropdownMenuPrimitive.Separator>,
	React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => <DropdownMenuPrimitive.Separator ref={ref} className={cn('fd-msep', className)} {...props} />)
DropdownMenuSeparator.displayName = DropdownMenuPrimitive.Separator.displayName

const DropdownMenuShortcut = ({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) => {
	return <span className={cn('fd-mi-sc', className)} {...props} />
}
DropdownMenuShortcut.displayName = 'DropdownMenuShortcut'

export {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuPortal,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
}
