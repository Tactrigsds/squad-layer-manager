import * as SubmitChord from '@/lib/submit-chord'
import { cn } from '@/lib/utils'

function Kbd({ className, ...props }: React.ComponentProps<'kbd'>) {
	return (
		<kbd
			data-slot="kbd"
			className={cn('fd-kbd pointer-events-none select-none', "[&_svg:not([class*='size-'])]:size-3", className)}
			{...props}
		/>
	)
}

function KbdGroup({ className, ...props }: React.ComponentProps<'div'>) {
	return <kbd data-slot="kbd-group" className={cn('inline-flex items-center gap-1', className)} {...props} />
}

function SubmitChordKbd({ className }: { className?: string }) {
	return (
		<KbdGroup className={className} aria-hidden>
			<Kbd>{SubmitChord.MODIFIER_LABEL}</Kbd>
			<Kbd>{SubmitChord.ENTER_LABEL}</Kbd>
		</KbdGroup>
	)
}

export { Kbd, KbdGroup, SubmitChordKbd }
