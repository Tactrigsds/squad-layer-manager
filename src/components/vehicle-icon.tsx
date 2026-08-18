import { cn } from '@/lib/utils'

// Squad's own vehicle map icons, extracted from the game's containers (see src/scripts/build-vehicle-icons.ts).
// Drawn as a CSS mask filled with currentColor, so one file serves both themes. Vehicle records spell the same
// icon with and without the T_ prefix, hence the normalized lookup.

const URLS = import.meta.glob('../assets/vehicle-icons/*.png', { eager: true, query: '?url', import: 'default' }) as Record<string, string>

const BY_NAME = new Map(Object.entries(URLS).map(([file, url]) => [file.slice(file.lastIndexOf('/') + 1, -'.png'.length), url]))

export default function VehicleIcon({ icon, size = 20, className }: { icon: string; size?: number; className?: string }) {
	const url = BY_NAME.get(icon.replace(/^T_/, '').toLowerCase())
	// mod vehicles name icons that ship in the mod's own paks, which we do not extract. The space is still held so
	// the column reads straight.
	if (!url) return <span aria-hidden className="shrink-0" style={{ width: size, height: size }} />
	return (
		<span
			aria-hidden
			className={cn('shrink-0 bg-current', className)}
			style={{
				width: size,
				height: size,
				maskImage: `url(${url})`,
				WebkitMaskImage: `url(${url})`,
				maskSize: 'contain',
				WebkitMaskSize: 'contain',
				maskRepeat: 'no-repeat',
				WebkitMaskRepeat: 'no-repeat',
				maskPosition: 'center',
				WebkitMaskPosition: 'center',
			}}
		/>
	)
}
