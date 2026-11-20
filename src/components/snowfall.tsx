import { useZIndex, ZI_OFFSETS } from '@/models/zindex.models'
import * as Christmas from '@/systems/christmas.client'

export default function Snowfall() {
	const active = Christmas.useActive()
	const zIndex = useZIndex(ZI_OFFSETS.SEASONAL_OVERLAY)
	if (!active) return null
	return (
		<canvas
			ref={startSnow}
			aria-hidden
			style={{ zIndex }}
			className="fixed inset-0 size-full pointer-events-none text-slate-400/70 dark:text-white/80 motion-reduce:hidden"
		/>
	)
}

// `pushX`/`pushY` are the velocity the cursor gave the flake, decaying back to its plain fall
type Flake = { x: number; y: number; r: number; vy: number; drift: number; phase: number; pushX: number; pushY: number }

const PX_PER_FLAKE = 9000
const MAX_FLAKES = 250
const CURSOR_RADIUS = 80
// px/s² at the cursor's centre, falling off linearly to nothing at CURSOR_RADIUS
const CURSOR_REPEL = 250
// share of the cursor's velocity a flake under it picks up per second
const CURSOR_WAKE = 2.5
// per second, for both the flakes' pushes and the cursor's own velocity
const PUSH_DECAY = 2.5
const MAX_CURSOR_SPEED = 2000

// Drives the canvas until React detaches the ref. The flake colour comes from the canvas's CSS `color`, so the theme
// classes above pick it, and it is re-read when the theme toggles the root element's class.
function startSnow(canvas: HTMLCanvasElement) {
	if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
	const g = canvas.getContext('2d')!
	let width = 0
	let height = 0
	let flakes: Flake[] = []
	let color = ''

	const newFlake = (y: number): Flake => {
		const r = 0.8 + Math.random() * 2.2
		return {
			x: Math.random() * width,
			y,
			r,
			vy: 15 + r * 18,
			drift: 10 + Math.random() * 20,
			phase: Math.random() * Math.PI * 2,
			pushX: 0,
			pushY: 0,
		}
	}
	const resize = () => {
		const dpr = window.devicePixelRatio || 1
		width = window.innerWidth
		height = window.innerHeight
		canvas.width = Math.round(width * dpr)
		canvas.height = Math.round(height * dpr)
		g.setTransform(dpr, 0, 0, dpr, 0, 0)
		const count = Math.min(MAX_FLAKES, Math.round((width * height) / PX_PER_FLAKE))
		flakes = flakes.slice(0, count)
		while (flakes.length < count) flakes.push(newFlake(Math.random() * height))
	}
	const readColor = () => {
		color = getComputedStyle(canvas).color
	}

	const cursor = { active: false, x: 0, y: 0, vx: 0, vy: 0, at: 0 }
	const onPointerMove = (e: PointerEvent) => {
		const elapsed = (e.timeStamp - cursor.at) / 1000
		if (cursor.active && elapsed > 0) {
			cursor.vx = clamp((e.clientX - cursor.x) / elapsed, MAX_CURSOR_SPEED)
			cursor.vy = clamp((e.clientY - cursor.y) / elapsed, MAX_CURSOR_SPEED)
		}
		cursor.active = true
		cursor.x = e.clientX
		cursor.y = e.clientY
		cursor.at = e.timeStamp
	}
	// a touch leaves no cursor behind once the finger lifts
	const onPointerUp = (e: PointerEvent) => {
		if (e.pointerType !== 'mouse') cursor.active = false
	}
	const onPointerLeave = () => {
		cursor.active = false
	}

	let frame = 0
	let last = performance.now()
	const tick = (now: number) => {
		// a backgrounded tab pauses rAF, so cap the step to keep flakes from jumping when it resumes
		const dt = Math.min(now - last, 100) / 1000
		last = now
		g.clearRect(0, 0, width, height)
		g.fillStyle = color
		const decay = Math.exp(-PUSH_DECAY * dt)
		cursor.vx *= decay
		cursor.vy *= decay
		g.beginPath()
		for (const f of flakes) {
			f.phase += dt
			let x = f.x + Math.sin(f.phase) * f.drift
			if (cursor.active) {
				const dx = x - cursor.x
				const dy = f.y - cursor.y
				const d2 = dx * dx + dy * dy
				if (d2 < CURSOR_RADIUS * CURSOR_RADIUS && d2 > 0) {
					const d = Math.sqrt(d2)
					const falloff = 1 - d / CURSOR_RADIUS
					f.pushX += ((dx / d) * CURSOR_REPEL + cursor.vx * CURSOR_WAKE) * falloff * dt
					f.pushY += ((dy / d) * CURSOR_REPEL + cursor.vy * CURSOR_WAKE) * falloff * dt
				}
			}
			f.pushX *= decay
			f.pushY *= decay
			f.x = (f.x + f.pushX * dt + width) % width
			f.y += (f.vy + f.pushY) * dt
			x = f.x + Math.sin(f.phase) * f.drift
			if (f.y - f.r > height) Object.assign(f, newFlake(-f.r))
			g.moveTo(x + f.r, f.y)
			g.arc(x, f.y, f.r, 0, Math.PI * 2)
		}
		g.fill()
		frame = requestAnimationFrame(tick)
	}

	resize()
	readColor()
	window.addEventListener('resize', resize)
	window.addEventListener('pointermove', onPointerMove, { passive: true })
	window.addEventListener('pointerup', onPointerUp, { passive: true })
	document.documentElement.addEventListener('pointerleave', onPointerLeave)
	const themeObserver = new MutationObserver(readColor)
	themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
	frame = requestAnimationFrame(tick)

	return () => {
		cancelAnimationFrame(frame)
		window.removeEventListener('resize', resize)
		window.removeEventListener('pointermove', onPointerMove)
		window.removeEventListener('pointerup', onPointerUp)
		document.documentElement.removeEventListener('pointerleave', onPointerLeave)
		themeObserver.disconnect()
	}
}

function clamp(value: number, limit: number) {
	return Math.max(-limit, Math.min(limit, value))
}
