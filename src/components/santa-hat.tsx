import { cn } from '@/lib/utils'

export default function SantaHat(props: { className?: string }) {
	return (
		<svg aria-hidden viewBox="0 0 32 20" className={cn('pointer-events-none drop-shadow-sm', props.className)}>
			<path d="M4 15 C6 6 13 1 21 2 C26 3 28 6 29 10 L25 10 L27 15 Z" fill="#d42a2a" />
			<path d="M9 12 C11 7 15 5 20 5" stroke="#a51d1d" strokeWidth="1.2" fill="none" strokeLinecap="round" />
			<rect x="2" y="13" width="28" height="6" rx="3" fill="#f5f5f5" />
			<circle cx="28.5" cy="10" r="3" fill="#f5f5f5" />
		</svg>
	)
}
