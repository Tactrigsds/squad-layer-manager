import * as Icons from 'lucide-react'
import React from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import * as UI_Msgs from '@/messages/ui.messages'
import { tr } from '@/systems/messages.client'

function formatPageCount(count: number): string {
	if (count < 1000) {
		return count.toString()
	} else if (count < 1_000_000) {
		const thousands = Math.floor(count / 1000)
		const remainder = Math.floor((count % 1000) / 100)
		return remainder > 0 ? `${thousands}.${remainder}k` : `${thousands}k`
	} else {
		const millions = Math.floor(count / 1_000_000)
		const remainder = Math.floor((count % 1_000_000) / 100_000)
		return remainder > 0 ? `${millions}.${remainder}m` : `${millions}m`
	}
}

export interface TablePaginationProps {
	pageIndex: number
	pageCount: number
	onPageChange: (pageIndex: number) => void
	disabled?: boolean
}

export function TablePagination({ pageIndex, pageCount, onPageChange, disabled = false }: TablePaginationProps) {
	const currentPage = pageIndex + 1
	// uncontrolled, keyed on pageIndex so a page change from anywhere else reseeds the field by remounting it
	const inputRef = React.useRef<HTMLInputElement>(null)

	const commit = () => {
		const parsed = parseInt(inputRef.current?.value ?? '', 10)
		const newPage = Math.max(1, Math.min(parsed, pageCount))
		if (!isNaN(newPage) && newPage > 0 && newPage <= pageCount) onPageChange(newPage - 1)
		if (inputRef.current) inputRef.current.value = String(isNaN(newPage) ? currentPage : newPage)
	}

	const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === 'Enter') commit()
		else if (e.key === 'Escape' && inputRef.current) inputRef.current.value = String(currentPage)
	}

	const handleFirst = () => {
		if (pageIndex !== 0) {
			onPageChange(0)
		}
	}

	const handlePrevious = () => {
		if (pageIndex > 0) {
			onPageChange(pageIndex - 1)
		}
	}

	const handleNext = () => {
		if (pageIndex < pageCount - 1) {
			onPageChange(pageIndex + 1)
		}
	}

	const handleLast = () => {
		if (pageIndex !== pageCount - 1) {
			onPageChange(pageCount - 1)
		}
	}

	const canGoPrevious = pageIndex > 0
	const canGoNext = pageIndex < pageCount - 1

	return (
		<div className="flex items-center gap-2">
			<Button
				variant="outline"
				size="icon"
				onClick={handleFirst}
				disabled={disabled || !canGoPrevious}
				title={tr.text(UI_Msgs.firstPageHint())}
				className="h-8 w-8"
			>
				<Icons.ChevronsLeft className="h-4 w-4" />
			</Button>

			<Button
				variant="outline"
				size="icon"
				onClick={handlePrevious}
				disabled={disabled || !canGoPrevious}
				title={tr.text(UI_Msgs.previousPageShortHint())}
				className="h-8 w-8"
			>
				<Icons.ChevronLeft className="h-4 w-4" />
			</Button>

			<div className="flex items-center gap-1 whitespace-nowrap">
				<Input
					key={pageIndex}
					ref={inputRef}
					type="number"
					min="1"
					max={pageCount}
					defaultValue={String(currentPage)}
					onBlur={commit}
					onKeyDown={handleInputKeyDown}
					disabled={disabled}
					className="h-8 w-16 text-center"
					aria-label={tr.text(UI_Msgs.pageNumber())}
				/>
				<span className="text-sm text-muted-foreground">/ {formatPageCount(pageCount)}</span>
			</div>

			<Button
				variant="outline"
				size="icon"
				onClick={handleNext}
				disabled={disabled || !canGoNext}
				title={tr.text(UI_Msgs.nextPageShortHint())}
				className="h-8 w-8"
			>
				<Icons.ChevronRight className="h-4 w-4" />
			</Button>

			<Button
				variant="outline"
				size="icon"
				onClick={handleLast}
				disabled={disabled || !canGoNext}
				title={tr.text(UI_Msgs.lastPageHint())}
				className="h-8 w-8"
			>
				<Icons.ChevronsRight className="h-4 w-4" />
			</Button>
		</div>
	)
}
