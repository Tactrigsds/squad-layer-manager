// The documentation site's only script (bundled by src/scripts/build-docs.ts). It opens search and turns the landing
// page's video thumbnail into a player on click. Pagefind loads on the first search, so a page that is only read
// never fetches it.

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

type VersionIndex = { latest: string | null; versions: string[] }

const MAX_RESULTS = 8
const NEXT_VERSION = 'next'
const base = document.documentElement.dataset.base ?? '/'
const root = document.documentElement.dataset.root ?? '/'
const version = document.documentElement.dataset.version ?? NEXT_VERSION
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

// A released version's pages are frozen, so the list of versions, and whether this one is outdated, come from the root.
async function setupVersions() {
	const list = document.querySelector('[data-version-list]')
	const banner = document.querySelector<HTMLElement>('[data-version-banner]')
	if (!list && !banner) return
	const res = await fetch(`${root}versions.json`).catch(() => null)
	if (!res?.ok) return
	const index = (await res.json()) as VersionIndex
	// the same page in another version, when this is a page inside a version folder
	const inVersion = location.pathname.startsWith(base) ? location.pathname.slice(base.length) + location.hash : ''
	const label = (v: string) => (v === NEXT_VERSION ? 'Unreleased' : v)

	if (list) {
		const links = index.versions.map((v) => {
			const a = document.createElement('a')
			a.href = `${root}${v}/${inVersion}`
			a.textContent = label(v)
			if (v === version) a.setAttribute('aria-current', 'page')
			const tag = v === index.latest ? 'latest' : v === NEXT_VERSION ? 'main' : null
			if (tag) {
				const span = document.createElement('span')
				span.className = 'docs-version-tag'
				span.textContent = tag
				a.append(span)
			}
			return a
		})
		list.replaceChildren(...links)
	}

	if (banner && location.pathname.startsWith(base) && version !== index.latest && index.latest) {
		const link = document.createElement('a')
		link.href = `${root}${index.latest}/${inVersion}`
		link.textContent = `the ${index.latest} docs`
		banner.append(
			version === NEXT_VERSION
				? 'These docs describe unreleased changes on main. For the latest release, see '
				: `These docs are for SLM ${version}, which is not the latest release. See `,
			link,
			'.',
		)
		banner.hidden = false
	}
}

setupSearch()
setupVideo()
setupCopyButtons()
void setupVersions()
