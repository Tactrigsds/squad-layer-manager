import * as Icons from 'lucide-react'
import React from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

// a labeled player id ("steam: 7656...") that copies itself on click, with transient "Copied!" feedback
export function CopyIdButton({ label, id }: { label: string; id: string }) {
	const [open, setOpen] = React.useState(false)
	const timeoutRef = React.useRef<ReturnType<typeof setTimeout>>(null)

	const handleClick = () => {
		void navigator.clipboard.writeText(id)
		setOpen(true)
		if (timeoutRef.current) clearTimeout(timeoutRef.current)
		timeoutRef.current = setTimeout(() => setOpen(false), 1500)
	}

	React.useEffect(() => () => {
		if (timeoutRef.current) clearTimeout(timeoutRef.current)
	}, [])

	return (
		<Tooltip open={open}>
			<TooltipTrigger asChild>
				<button
					type="button"
					className="inline-flex items-center gap-1 hover:text-foreground transition-colors cursor-pointer"
					title={`Copy ${label} ID`}
					onClick={handleClick}
				>
					<span className="font-mono text-muted-foreground">{label}:</span>
					<span className="font-mono">{id}</span>
					<Icons.Copy className="h-3 w-3" />
				</button>
			</TooltipTrigger>
			<TooltipContent>Copied!</TooltipContent>
		</Tooltip>
	)
}
