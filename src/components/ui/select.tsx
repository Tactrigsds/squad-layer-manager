import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from '@radix-ui/react-icons'
import * as SelectPrimitive from '@radix-ui/react-select'
import * as React from 'react'

import * as MenuSizing from '@/components/ui/menu-sizing.ts'
import { cn } from '@/lib/utils'
import { BaseZIndexContext, useZIndex, ZI_OFFSETS } from '@/models/zindex.models'

const Select = SelectPrimitive.Root

const SelectGroup = SelectPrimitive.Group

const SelectValue = SelectPrimitive.Value

const SelectTrigger = React.forwardRef<
	React.ElementRef<typeof SelectPrimitive.Trigger>,
	React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, onPointerEnter, ...props }, ref) => (
	<SelectPrimitive.Trigger
		ref={ref}
		className={cn('fd-inp fd-sel w-full', className)}
		onPointerEnter={(e) => {
			titleTruncatedValue(e.currentTarget)
			onPointerEnter?.(e)
		}}
		{...props}
	>
		{children}
		<SelectPrimitive.Icon asChild>
			<ChevronDownIcon />
		</SelectPrimitive.Icon>
	</SelectPrimitive.Trigger>
))
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName

// Shows a value the trigger cuts off in full, as a native title. A title set by anyone else, including the empty one
// a TooltipTrigger sets, is left alone.
function titleTruncatedValue(trigger: HTMLButtonElement) {
	const value = trigger.firstElementChild
	if (!(value instanceof HTMLElement)) return
	const owned = trigger.dataset.valueTitle !== undefined
	if (!owned && trigger.hasAttribute('title')) return
	if (value.scrollWidth > value.clientWidth) {
		trigger.title = value.textContent ?? ''
		trigger.dataset.valueTitle = ''
	} else if (owned) {
		trigger.removeAttribute('title')
		delete trigger.dataset.valueTitle
	}
}

const SelectScrollUpButton = React.forwardRef<
	React.ElementRef<typeof SelectPrimitive.ScrollUpButton>,
	React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollUpButton>
>(({ className, ...props }, ref) => (
	<SelectPrimitive.ScrollUpButton ref={ref} className={cn('flex cursor-default items-center justify-center py-0.5', className)} {...props}>
		<ChevronUpIcon />
	</SelectPrimitive.ScrollUpButton>
))
SelectScrollUpButton.displayName = SelectPrimitive.ScrollUpButton.displayName

const SelectScrollDownButton = React.forwardRef<
	React.ElementRef<typeof SelectPrimitive.ScrollDownButton>,
	React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollDownButton>
>(({ className, ...props }, ref) => (
	<SelectPrimitive.ScrollDownButton
		ref={ref}
		className={cn('flex cursor-default items-center justify-center py-0.5', className)}
		{...props}
	>
		<ChevronDownIcon />
	</SelectPrimitive.ScrollDownButton>
))
SelectScrollDownButton.displayName = SelectPrimitive.ScrollDownButton.displayName

const SelectContent = React.forwardRef<
	React.ElementRef<typeof SelectPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = 'popper', style, ...props }, ref) => {
	const zIndex = useZIndex(ZI_OFFSETS.POPOVER)
	return (
		<SelectPrimitive.Portal>
			<SelectPrimitive.Content
				ref={ref}
				className={cn(
					'fd-menu relative overflow-hidden',
					MenuSizing.MENU_MIN_WIDTH_CLASS,
					MenuSizing.MENU_MAX_WIDTH_CLASS,
					position === 'popper' && 'max-h-(--radix-select-content-available-height)',
					position === 'popper' &&
						'data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1',
					className,
				)}
				position={position}
				style={{ zIndex, ...style }}
				{...props}
			>
				<SelectScrollUpButton />
				<SelectPrimitive.Viewport
					className={cn(MenuSizing.MENU_LIST_MAX_HEIGHT_CLASS, position === 'popper' && 'h-(--radix-select-trigger-height) w-full')}
				>
					<BaseZIndexContext.Provider value={zIndex}>{children}</BaseZIndexContext.Provider>
				</SelectPrimitive.Viewport>
				<SelectScrollDownButton />
			</SelectPrimitive.Content>
		</SelectPrimitive.Portal>
	)
})
SelectContent.displayName = SelectPrimitive.Content.displayName

const SelectLabel = React.forwardRef<
	React.ElementRef<typeof SelectPrimitive.Label>,
	React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(({ className, ...props }, ref) => <SelectPrimitive.Label ref={ref} className={cn('fd-mlabel', className)} {...props} />)
SelectLabel.displayName = SelectPrimitive.Label.displayName

const SelectItem = React.forwardRef<
	React.ElementRef<typeof SelectPrimitive.Item>,
	React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
	<SelectPrimitive.Item ref={ref} className={cn('fd-mi relative w-full pe-7', className)} {...props}>
		<span className="min-w-0 line-clamp-2 py-px">
			<SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
		</span>
		<span className="absolute inset-e-2 flex h-3.5 w-3.5 items-center justify-center text-pri-hi">
			<SelectPrimitive.ItemIndicator>
				<CheckIcon className="h-4 w-4" />
			</SelectPrimitive.ItemIndicator>
		</span>
	</SelectPrimitive.Item>
))
SelectItem.displayName = SelectPrimitive.Item.displayName

const SelectSeparator = React.forwardRef<
	React.ElementRef<typeof SelectPrimitive.Separator>,
	React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>
>(({ className, ...props }, ref) => <SelectPrimitive.Separator ref={ref} className={cn('fd-msep', className)} {...props} />)
SelectSeparator.displayName = SelectPrimitive.Separator.displayName

export {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectScrollDownButton,
	SelectScrollUpButton,
	SelectSeparator,
	SelectTrigger,
	SelectValue,
}
