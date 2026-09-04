import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

function InputGroup({ className, ...props }: React.ComponentProps<'div'>) {
	return (
		<div
			data-slot="input-group"
			role="group"
			className={cn(
				'group/input-group fd-inp relative flex w-full items-center gap-0 px-0',
				'has-[>textarea]:h-auto',
				// Variants based on alignment.
				'has-[>[data-align=inline-start]]:[&>input]:pl-2',
				'has-[>[data-align=inline-end]]:[&>input]:pr-2',
				'has-[>[data-align=block-start]]:h-auto has-[>[data-align=block-start]]:flex-col has-[>[data-align=block-start]]:[&>input]:pb-3',
				'has-[>[data-align=block-end]]:h-auto has-[>[data-align=block-end]]:flex-col has-[>[data-align=block-end]]:[&>input]:pt-3',
				'has-[[data-slot][aria-invalid=true]]:fd-inp-err',
				className,
			)}
			{...props}
		/>
	)
}

const inputGroupAddonVariants = cva(
	"text-text-3 flex h-auto cursor-text select-none items-center justify-center gap-1.5 text-sm font-medium group-data-[disabled=true]/input-group:opacity-50 [&>svg:not([class*='size-'])]:size-3.5",
	{
		variants: {
			align: {
				'inline-start': 'order-first pl-2',
				'inline-end': 'order-last pr-1.5',
				'block-start': 'order-first w-full justify-start px-2 pt-2',
				'block-end': 'order-last w-full justify-start px-2 pb-2',
			},
		},
		defaultVariants: {
			align: 'inline-start',
		},
	},
)

function InputGroupAddon({
	className,
	align = 'inline-start',
	...props
}: React.ComponentProps<'div'> & VariantProps<typeof inputGroupAddonVariants>) {
	return (
		<div
			role="group"
			data-slot="input-group-addon"
			data-align={align}
			className={cn(inputGroupAddonVariants({ align }), className)}
			onClick={(e) => {
				if ((e.target as HTMLElement).closest('button')) {
					return
				}
				e.currentTarget.parentElement?.querySelector('input')?.focus()
			}}
			{...props}
		/>
	)
}

const inputGroupButtonVariants = cva('flex items-center gap-2 text-sm shadow-none', {
	variants: {
		size: {
			xs: 'fd-btn-sm gap-1 px-1.5',
			sm: 'gap-1.5 px-2',
			'icon-xs': 'fd-btn-sm fd-btn-ico',
			'icon-sm': 'fd-btn-ico',
		},
	},
	defaultVariants: {
		size: 'xs',
	},
})

function InputGroupButton({
	className,
	type = 'button',
	variant = 'ghost',
	size = 'xs',
	...props
}: Omit<React.ComponentProps<typeof Button>, 'size'> & VariantProps<typeof inputGroupButtonVariants>) {
	return <Button type={type} data-size={size} variant={variant} className={cn(inputGroupButtonVariants({ size }), className)} {...props} />
}

function InputGroupText({ className, ...props }: React.ComponentProps<'span'>) {
	return (
		<span
			className={cn(
				"text-text-3 flex items-center gap-1.5 text-sm [&_svg:not([class*='size-'])]:size-3.5 [&_svg]:pointer-events-none",
				className,
			)}
			{...props}
		/>
	)
}

function InputGroupInput({ className, ...props }: React.ComponentProps<'input'>) {
	return (
		<Input
			data-slot="input-group-control"
			className={cn('flex-1 shadow-none! bg-transparent! outline-none! focus:outline-none!', className)}
			{...props}
		/>
	)
}

function InputGroupTextarea({ className, ...props }: React.ComponentProps<'textarea'>) {
	return (
		<Textarea
			data-slot="input-group-control"
			className={cn('flex-1 resize-none shadow-none! bg-transparent! outline-none! focus:outline-none! py-2', className)}
			{...props}
		/>
	)
}

export { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput, InputGroupText, InputGroupTextarea }
