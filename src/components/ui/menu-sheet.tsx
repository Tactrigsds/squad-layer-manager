import * as DialogPrimitive from '@radix-ui/react-dialog'
import { ChevronLeftIcon, ChevronRightIcon } from '@radix-ui/react-icons'
import * as React from 'react'

import type { MenuSlots } from '@/components/player-context-menu-options'
import { cn } from '@/lib/utils'
import * as UI_Msgs from '@/messages/ui.messages'
import { BaseZIndexContext, useZIndex, ZI_OFFSETS } from '@/models/zindex'
import { tr } from '@/systems/messages.client'

// A menu as a sheet from the bottom of a phone screen, for the row and selection menus whose desktop form is a
// context menu at the pointer. A submenu is a page of the same sheet rather than a flyout: SubTrigger is a row
// with a chevron that pushes the page, and the page's header pops it. The action code renders through MenuSlots
// and does not know which form it is in.

type Page = { title: React.ReactNode; content: React.ReactNode }

type SheetCtx = {
	close: () => void
	push: (page: Page) => void
}

const SheetContext = React.createContext<SheetCtx | null>(null)

function useSheet(): SheetCtx {
	const ctx = React.useContext(SheetContext)
	if (!ctx) throw new Error('sheet menu slots rendered outside a MenuSheet')
	return ctx
}

export function MenuSheet(props: {
	open: boolean
	onOpenChange: (open: boolean) => void
	title: React.ReactNode
	subtitle?: React.ReactNode
	// rendered on the right of the header, beside the title
	trailing?: React.ReactNode
	children: React.ReactNode
}) {
	const zIndex = useZIndex(ZI_OFFSETS.DIALOG)
	return (
		<DialogPrimitive.Root open={props.open} onOpenChange={props.onOpenChange}>
			<DialogPrimitive.Portal>
				<DialogPrimitive.Overlay className="fixed inset-0 bg-black/60" style={{ zIndex }} />
				<DialogPrimitive.Content
					className="fd-dlg fixed inset-x-0 bottom-0 flex max-h-[88vh] flex-col overflow-hidden rounded-b-none border-x-0 border-b-0 outline-none"
					style={{ zIndex }}
					aria-describedby={undefined}
					onOpenAutoFocus={(e) => e.preventDefault()}
				>
					<BaseZIndexContext.Provider value={zIndex}>
						<SheetBody {...props} />
					</BaseZIndexContext.Provider>
				</DialogPrimitive.Content>
			</DialogPrimitive.Portal>
		</DialogPrimitive.Root>
	)
}

// Mounts with the dialog content, so each open starts on the root page.
function SheetBody(props: {
	onOpenChange: (open: boolean) => void
	title: React.ReactNode
	subtitle?: React.ReactNode
	trailing?: React.ReactNode
	children: React.ReactNode
}) {
	const { onOpenChange } = props
	const [pages, setPages] = React.useState<Page[]>([])
	const ctx = React.useMemo<SheetCtx>(
		() => ({
			close: () => onOpenChange(false),
			push: (page) => setPages((current) => [...current, page]),
		}),
		[onOpenChange],
	)
	const top = pages[pages.length - 1]
	return (
		<SheetContext.Provider value={ctx}>
			<div className="mx-auto mt-1.5 h-1 w-9 shrink-0 rounded-full bg-line-soft" />
			{top ? (
				<div className="flex min-h-10 shrink-0 items-center gap-1 border-b border-line pr-2">
					<button
						type="button"
						onClick={() => setPages((current) => current.slice(0, -1))}
						className="fd-btn fd-btn-ghost fd-btn-ico"
						aria-label={tr.text(UI_Msgs.back())}
					>
						<ChevronLeftIcon />
					</button>
					<DialogPrimitive.Title className="fd-cond min-w-0 flex-1 truncate text-base font-bold">{top.title}</DialogPrimitive.Title>
				</div>
			) : (
				<div className="flex min-h-10 shrink-0 items-center gap-2 border-b border-line px-3 py-1.5">
					<div className="flex min-w-0 flex-1 flex-col">
						<DialogPrimitive.Title className="fd-cond truncate text-base font-bold">{props.title}</DialogPrimitive.Title>
						{props.subtitle && <span className="truncate text-xs text-text-2">{props.subtitle}</span>}
					</div>
					{props.trailing}
				</div>
			)}
			<div className="min-h-0 flex-1 overflow-y-auto p-1 [&_.fd-mi-sc]:hidden">{top ? top.content : props.children}</div>
		</SheetContext.Provider>
	)
}

type SubCtx = { setContent: (content: React.ReactNode) => void; getContent: () => React.ReactNode }
const SubContext = React.createContext<SubCtx | null>(null)

function SheetItem(props: { onClick?: () => void; disabled?: boolean; className?: string; children?: React.ReactNode }) {
	const sheet = useSheet()
	return (
		<button
			type="button"
			disabled={props.disabled}
			className={cn('fd-mi w-full text-left disabled:opacity-40', props.className)}
			onClick={() => {
				props.onClick?.()
				sheet.close()
			}}
		>
			{props.children}
		</button>
	)
}

function SheetSeparator() {
	return <div className="fd-msep" />
}

function SheetLabel(props: { children?: React.ReactNode }) {
	return <div className="fd-mlabel">{props.children}</div>
}

function SheetSub(props: { children?: React.ReactNode }) {
	const contentRef = React.useRef<React.ReactNode>(null)
	const value = React.useMemo<SubCtx>(
		() => ({
			setContent: (content) => {
				contentRef.current = content
			},
			getContent: () => contentRef.current,
		}),
		[],
	)
	return <SubContext.Provider value={value}>{props.children}</SubContext.Provider>
}

function SheetSubTrigger(props: { disabled?: boolean; children?: React.ReactNode }) {
	const sheet = useSheet()
	const sub = React.useContext(SubContext)
	return (
		<button
			type="button"
			disabled={props.disabled}
			className="fd-mi w-full text-left disabled:opacity-40"
			onClick={() => sub && sheet.push({ title: props.children, content: sub.getContent() })}
		>
			{props.children}
			<ChevronRightIcon className="ml-auto text-text-3" />
		</button>
	)
}

// Holds its page for the trigger beside it rather than rendering in place. Written during render: the trigger
// reads it on a tap, long after both have rendered.
function SheetSubContent(props: { children?: React.ReactNode }) {
	const sub = React.useContext(SubContext)
	sub?.setContent(props.children)
	return null
}

export const sheetMenuSlots: MenuSlots = {
	Item: SheetItem,
	Separator: SheetSeparator,
	Label: SheetLabel,
	Sub: SheetSub,
	SubTrigger: SheetSubTrigger,
	SubContent: SheetSubContent,
}
