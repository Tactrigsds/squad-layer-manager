import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import * as Icons from 'lucide-react'
import React from 'react'

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

export function TablePagination({
	pageIndex,
	pageCount,
	onPageChange,
	disabled = false,
}: TablePaginationProps) {
	const currentPage = pageIndex + 1
	const [inputValue, setInputValue] = React.useState(String(currentPage))

	// Update input when pageIndex changes externally
	React.useEffect(() => {
		setInputValue(String(pageIndex + 1))
	}, [pageIndex])

	const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		setInputValue(e.target.value)
	}

	const handleInputBlur = () => {
		let newPage = parseInt(inputValue, 10)
		newPage = Math.max(1, Math.min(newPage, pageCount))
		if (!isNaN(newPage) && newPage > 0 && newPage <= pageCount) {
			onPageChange(newPage - 1)
			setInputValue(String(newPage))
		} else {
			// Reset to current page if invalid
			setInputValue(String(currentPage))
		}
	}

	const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === 'Enter') {
			handleInputBlur()
		} else if (e.key === 'Escape') {
			setInputValue(String(currentPage))
		}
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
				title="First page"
				className="h-8 w-8"
			>
				<Icons.ChevronsLeft className="h-4 w-4" />
			</Button>

			<Button
				variant="outline"
				size="icon"
				onClick={handlePrevious}
				disabled={disabled || !canGoPrevious}
				title="Previous page"
				className="h-8 w-8"
			>
				<Icons.ChevronLeft className="h-4 w-4" />
			</Button>

			<div className="flex items-center gap-1 whitespace-nowrap">
				<Input
					type="number"
					min="1"
					max={pageCount}
					value={inputValue}
					onChange={handleInputChange}
					onBlur={handleInputBlur}
					onKeyDown={handleInputKeyDown}
					disabled={disabled}
					className="h-8 w-16 text-center"
					aria-label="Page number"
				/>
				<span className="text-sm text-muted-foreground">
					/ {formatPageCount(pageCount)}
				</span>
			</div>

			<Button
				variant="outline"
				size="icon"
				onClick={handleNext}
				disabled={disabled || !canGoNext}
				title="Next page"
				className="h-8 w-8"
			>
				<Icons.ChevronRight className="h-4 w-4" />
			</Button>

			<Button
				variant="outline"
				size="icon"
				onClick={handleLast}
				disabled={disabled || !canGoNext}
				title="Last page"
				className="h-8 w-8"
			>
				<Icons.ChevronsRight className="h-4 w-4" />
			</Button>
		</div>
	)
}
