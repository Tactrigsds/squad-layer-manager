// The documentation site's only script (bundled by src/scripts/build-docs.ts). It opens search, fills the version
// menu, turns the landing page's video thumbnail into a player on click, and opens figures in a lightbox. Pagefind loads on the first search, so a
// page that is only read never fetches it. It imports nothing, so the version names below mirror
// src/models/docs-site.models.ts.

type PagefindSubResult = { title: string; url: string; excerpt: string; weighted_locations: { balanced_score: number }[] }
type PagefindData = {
	url: string
	excerpt: string
	meta: { title?: string }
	filters: { section?: string[] }
	sub_results: PagefindSubResult[]
}
type Pagefind = {
	options(opts: { baseUrl?: string; excerptLength?: number }): Promise<void>
	debouncedSearch(query: string, opts?: object, ms?: number): Promise<{ results: { data(): Promise<PagefindData> }[] } | null>
}

type VersionIndex = { stable: string | null; versions: string[] }

const MAX_RESULTS = 8
const LATEST_VERSION = 'latest'
const STABLE_VERSION = 'stable'
const base = document.documentElement.dataset.base ?? '/'
const root = document.documentElement.dataset.root ?? '/'
const version = document.documentElement.dataset.version ?? LATEST_VERSION
let pagefind: Promise<Pagefind> | null = null

function loadPagefind() {
	pagefind ??= (async () => {
		const pf = (await import(/* @vite-ignore */ `${base}pagefind/pagefind.js`)) as Pagefind
		await pf.options({ baseUrl: base, excerptLength: 24 })
		return pf
	})()
	return pagefind
}

function setupSearch() {
	const dialog = document.getElementById('docs-search') as HTMLDialogElement | null
	if (!dialog) return
	const input = dialog.querySelector('input')!
	const list = dialog.querySelector('ul')!
	const status = dialog.querySelector('.docs-search-status')!
	let selected = -1
	let generation = 0

	const open = () => {
		if (dialog.open) return
		dialog.showModal()
		input.select()
		void loadPagefind()
	}
	for (const btn of document.querySelectorAll('[data-search-open]')) btn.addEventListener('click', open)

	document.addEventListener('keydown', (e) => {
		const inField = e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))
		if ((e.key === '/' && !inField) || (e.key === 'k' && (e.metaKey || e.ctrlKey))) {
			e.preventDefault()
			open()
		}
	})

	// a click on the backdrop lands on the dialog element itself
	dialog.addEventListener('click', (e) => {
		if (e.target === dialog) dialog.close()
	})

	const links = () => [...list.querySelectorAll('a')]
	const select = (i: number) => {
		const all = links()
		if (all.length === 0) return
		selected = (i + all.length) % all.length
		all.forEach((a, j) => a.setAttribute('aria-selected', String(j === selected)))
		all[selected].scrollIntoView({ block: 'nearest' })
		input.setAttribute('aria-activedescendant', all[selected].id)
	}

	input.addEventListener('keydown', (e) => {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault()
			select(selected + (e.key === 'ArrowDown' ? 1 : -1))
		} else if (e.key === 'Enter') {
			e.preventDefault()
			links()[selected]?.click()
		}
	})

	input.addEventListener('input', async () => {
		const query = input.value.trim()
		const mine = ++generation
		if (!query) {
			list.replaceChildren()
			status.textContent = ''
			input.setAttribute('aria-expanded', 'false')
			return
		}
		const pf = await loadPagefind()
		const search = await pf.debouncedSearch(query, {}, 120)
		// null means a newer keystroke superseded this search
		if (search === null || mine !== generation) return
		const pages = await Promise.all(search.results.slice(0, MAX_RESULTS).map((r) => r.data()))
		if (mine !== generation) return
		render(pages)
		status.textContent = pages.length === 0 ? `No pages mention “${query}”.` : ''
		input.setAttribute('aria-expanded', String(pages.length > 0))
	})

	const render = (pages: PagefindData[]) => {
		const items: HTMLLIElement[] = []
		for (const page of pages) {
			const title = page.meta.title ?? page.url
			// pagefind lists a page's matching sections in page order, so rank them by match strength
			const subs = page.sub_results
				.filter((s) => s.title !== title)
				.map((s) => ({ s, score: s.weighted_locations.reduce((sum, l) => sum + l.balanced_score, 0) }))
				.sort((a, b) => b.score - a.score)
				.slice(0, 2)
				.map(({ s }) => s)
			const entries =
				subs.length > 0 ? subs.map((s) => ({ ...s, heading: s.title })) : [{ url: page.url, excerpt: page.excerpt, heading: null }]
			for (const entry of entries) {
				if (items.length >= MAX_RESULTS) break
				const li = document.createElement('li')
				const a = document.createElement('a')
				a.href = entry.url
				a.id = `docs-result-${items.length}`
				a.setAttribute('role', 'option')
				const head = document.createElement('span')
				head.className = 'docs-result-title'
				head.textContent = entry.heading ? `${title} › ${entry.heading}` : title
				const section = page.filters.section?.[0]
				if (section) {
					const label = document.createElement('span')
					label.className = 'docs-label'
					label.textContent = section
					a.append(label)
				}
				const excerpt = document.createElement('span')
				// pagefind escapes the page text and adds only <mark>
				excerpt.innerHTML = entry.excerpt
				a.append(head, excerpt)
				a.addEventListener('click', () => dialog.close())
				li.append(a)
				items.push(li)
			}
		}
		list.replaceChildren(...items)
		selected = -1
		select(0)
	}
}

function setupVideo() {
	for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-youtube-id]')) {
		btn.addEventListener(
			'click',
			() => {
				const player = document.createElement('div')
				player.className = 'docs-video'
				const iframe = document.createElement('iframe')
				iframe.src = `https://www.youtube-nocookie.com/embed/${btn.dataset.youtubeId}?autoplay=1`
				iframe.title = 'SLM video'
				iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen'
				iframe.allowFullscreen = true
				player.append(iframe)
				btn.replaceWith(player)
				iframe.focus()
			},
			{ once: true },
		)
	}
}

function setupCopyButtons() {
	for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
		const pre = btn.parentElement?.querySelector('pre')
		if (!pre || !navigator.clipboard) continue
		let reset: ReturnType<typeof setTimeout> | undefined
		btn.hidden = false
		btn.addEventListener('click', () => {
			void navigator.clipboard.writeText(pre.textContent?.replace(/\n$/, '') ?? '').then(() => {
				btn.dataset.copied = ''
				btn.setAttribute('aria-label', 'Copied')
				clearTimeout(reset)
				reset = setTimeout(() => {
					delete btn.dataset.copied
					btn.setAttribute('aria-label', 'Copy code')
				}, 1500)
			})
		})
	}
}

// Opens a figure's image over the page, as large as fits the viewport. The wheel, a pinch, a click on the image and the
// + - 0 keys zoom, a drag pans, and a click beside the image closes it.
function setupLightbox() {
	const dialog = document.getElementById('docs-lightbox') as HTMLDialogElement | null
	if (!dialog) return
	const stage = dialog.querySelector<HTMLElement>('.docs-lightbox-stage')!
	const img = stage.querySelector('img')!
	const caption = dialog.querySelector<HTMLElement>('.docs-lightbox-caption')!
	const MAX_ZOOM = 8
	const CLICK_ZOOM = 2.5
	const KEY_ZOOM = 1.25
	const DRAG_THRESHOLD = 4

	// the image's unscaled size, its scale, and its offset from the stage's top left corner
	let w = 1
	let h = 1
	let fit = 1
	let scale = 1
	let tx = 0
	let ty = 0

	const place = () => {
		const sw = w * scale
		const sh = h * scale
		tx = sw <= stage.clientWidth ? (stage.clientWidth - sw) / 2 : Math.min(0, Math.max(stage.clientWidth - sw, tx))
		ty = sh <= stage.clientHeight ? (stage.clientHeight - sh) / 2 : Math.min(0, Math.max(stage.clientHeight - sh, ty))
		img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`
		stage.toggleAttribute('data-zoomed', scale > fit * 1.001)
	}
	const fitToStage = () => {
		fit = Math.min(stage.clientWidth / w, stage.clientHeight / h)
		scale = fit
		place()
	}
	// zooms to `next`, keeping the image point under (x, y) in place
	const zoomAt = (next: number, x: number, y: number) => {
		const clamped = Math.min(Math.max(next, fit), fit * MAX_ZOOM)
		tx = x - (x - tx) * (clamped / scale)
		ty = y - (y - ty) * (clamped / scale)
		scale = clamped
		place()
	}
	const stagePoint = (e: { clientX: number; clientY: number }) => {
		const rect = stage.getBoundingClientRect()
		return { x: e.clientX - rect.left, y: e.clientY - rect.top }
	}

	const open = (link: HTMLAnchorElement) => {
		const thumb = link.querySelector('img')
		if (!thumb) return
		w = Number(thumb.getAttribute('width')) || thumb.naturalWidth || 1
		h = Number(thumb.getAttribute('height')) || thumb.naturalHeight || 1
		img.style.width = `${w}px`
		img.style.height = `${h}px`
		img.src = link.href
		img.alt = thumb.alt
		caption.textContent = link.closest('figure')?.querySelector('figcaption')?.textContent ?? ''
		dialog.showModal()
		// the close button would take focus, and show its focus ring to a reader who clicked
		dialog.focus()
		fitToStage()
	}
	document.addEventListener('click', (e) => {
		const link = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>('a[data-lightbox]') : null
		if (!link || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
		e.preventDefault()
		open(link)
	})
	dialog.querySelector('[data-lightbox-close]')!.addEventListener('click', () => dialog.close())
	window.addEventListener('resize', () => {
		if (dialog.open) fitToStage()
	})

	stage.addEventListener(
		'wheel',
		(e) => {
			e.preventDefault()
			const p = stagePoint(e)
			zoomAt(scale * Math.exp(-e.deltaY * (e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 0.05 : 0.0015)), p.x, p.y)
		},
		{ passive: false },
	)

	const pointers = new Map<number, { x: number; y: number }>()
	let travelled = 0
	let downOnImage = false
	stage.addEventListener('pointerdown', (e) => {
		stage.setPointerCapture(e.pointerId)
		pointers.set(e.pointerId, stagePoint(e))
		if (pointers.size === 1) {
			travelled = 0
			downOnImage = e.target === img
		}
	})
	stage.addEventListener('pointermove', (e) => {
		const prev = pointers.get(e.pointerId)
		if (!prev) return
		const cur = stagePoint(e)
		if (pointers.size === 1) {
			travelled += Math.hypot(cur.x - prev.x, cur.y - prev.y)
			if (travelled > DRAG_THRESHOLD) {
				stage.toggleAttribute('data-dragging', true)
				tx += cur.x - prev.x
				ty += cur.y - prev.y
				place()
			}
		} else if (pointers.size === 2) {
			const other = [...pointers].find(([id]) => id !== e.pointerId)![1]
			const before = Math.hypot(prev.x - other.x, prev.y - other.y)
			const after = Math.hypot(cur.x - other.x, cur.y - other.y)
			travelled = Infinity
			tx += (cur.x - prev.x) / 2
			ty += (cur.y - prev.y) / 2
			if (before > 0) zoomAt(scale * (after / before), (cur.x + other.x) / 2, (cur.y + other.y) / 2)
		}
		pointers.set(e.pointerId, cur)
	})
	const release = (e: PointerEvent) => {
		const at = pointers.get(e.pointerId)
		if (!pointers.delete(e.pointerId) || pointers.size > 0) return
		stage.removeAttribute('data-dragging')
		if (e.type === 'pointercancel' || travelled > DRAG_THRESHOLD || !at) return
		if (!downOnImage) dialog.close()
		else if (scale > fit * 1.001) fitToStage()
		else zoomAt(scale * CLICK_ZOOM, at.x, at.y)
	}
	stage.addEventListener('pointerup', release)
	stage.addEventListener('pointercancel', release)

	dialog.addEventListener('keydown', (e) => {
		const cx = stage.clientWidth / 2
		const cy = stage.clientHeight / 2
		if (e.key === '+' || e.key === '=') zoomAt(scale * KEY_ZOOM, cx, cy)
		else if (e.key === '-') zoomAt(scale / KEY_ZOOM, cx, cy)
		else if (e.key === '0') fitToStage()
		else return
		e.preventDefault()
	})
}

// remembers whether the reader collapsed the table of contents, across pages and visits
const TOC_COLLAPSED_KEY = 'docs-toc-collapsed'

function setupTocToggle() {
	const btn = document.querySelector<HTMLButtonElement>('[data-toc-toggle]')
	const toc = btn?.closest<HTMLElement>('.docs-toc')
	if (!btn || !toc) return
	const apply = (collapsed: boolean) => {
		toc.toggleAttribute('data-collapsed', collapsed)
		const label = collapsed ? 'Expand subheadings' : 'Collapse subheadings'
		btn.setAttribute('aria-expanded', String(!collapsed))
		btn.setAttribute('aria-label', label)
		btn.title = label
	}
	let collapsed = false
	try {
		collapsed = localStorage.getItem(TOC_COLLAPSED_KEY) === '1'
	} catch {}
	apply(collapsed)
	btn.hidden = false
	btn.addEventListener('click', () => {
		collapsed = !collapsed
		apply(collapsed)
		try {
			localStorage.setItem(TOC_COLLAPSED_KEY, collapsed ? '1' : '0')
		} catch {}
	})
}

// A released version's pages are frozen, so the list of versions, and whether this one is outdated, come from the root.
async function setupVersions() {
	const lists = document.querySelectorAll('[data-version-list]')
	const banner = document.querySelector<HTMLElement>('[data-version-banner]')
	if (lists.length === 0 && !banner) return
	const res = await fetch(`${root}versions.json`).catch(() => null)
	if (!res?.ok) return
	const index = (await res.json()) as VersionIndex
	// the same page in another version, when this is a page inside a version folder
	const inVersion = location.pathname.startsWith(base) ? location.pathname.slice(base.length) + location.hash : ''
	// the release stable holds is listed once, as stable
	const shown = index.versions.filter((v) => v !== index.stable)
	const current = version === index.stable ? STABLE_VERSION : version

	for (const list of lists) {
		const links = shown.map((v) => {
			const a = document.createElement('a')
			a.href = `${root}${v}/${inVersion}`
			a.textContent = v === STABLE_VERSION && index.stable ? `stable (${index.stable})` : v
			if (v === current) a.setAttribute('aria-current', 'page')
			if (v === LATEST_VERSION) {
				const span = document.createElement('span')
				span.className = 'docs-version-tag'
				span.textContent = 'main'
				a.append(span)
			}
			return a
		})
		list.replaceChildren(...links)
	}

	if (banner && location.pathname.startsWith(base) && index.stable && current !== STABLE_VERSION) {
		const link = document.createElement('a')
		link.href = `${root}${STABLE_VERSION}/${inVersion}`
		link.textContent = `the stable docs (${index.stable})`
		banner.append(
			version === LATEST_VERSION
				? 'These docs describe unreleased changes on main. For the latest release, see '
				: `These docs are for SLM ${version}, which is not the latest release. See `,
			link,
			'.',
		)
		banner.hidden = false
	}
}

// The version folders were once named next/ and v<release>/. App builds and pages from then still link to those
// names, which land on the 404 page, so it sends them on to latest/ and <release>/.
function redirectLegacyPath() {
	if (!document.querySelector('[data-not-found]') || !location.pathname.startsWith(root)) return
	const m = /^(?:next|v(\d+(?:\.\d+)*))(\/.*)?$/.exec(location.pathname.slice(root.length))
	if (!m) return
	location.replace(`${root}${m[1] ?? LATEST_VERSION}${m[2] ?? '/'}${location.search}${location.hash}`)
}

redirectLegacyPath()
setupSearch()
setupVideo()
setupCopyButtons()
setupLightbox()
setupTocToggle()
void setupVersions()
