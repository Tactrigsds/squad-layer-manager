// The documentation site's pages, rendered to static HTML by src/scripts/build-docs.ts and never mounted in the app.
// The only script a page loads is docs-site.client.ts, for search and the video facade.
import {
	Check,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	ChevronsDownUp,
	ChevronsUpDown,
	Code,
	Copy,
	Link as LinkIcon,
	Menu,
	Pencil,
	Search,
} from 'lucide-react'
import * as React from 'react'

import LogoMark from '@/components/logo-mark'
import * as DS from '@/models/docs-site.models'

export type SiteInfo = {
	// the version folder the pages link into, e.g. /v2026.9.4/
	base: string
	// the site root, which holds the landing page, the unversioned pages and versions.json
	root: string
	// where the pages' images and other copied files are served from
	assetBase: string
	// pages the version at `base` does not have, which are linked in the next version instead
	absent?: ReadonlySet<string>
	// the version these pages belong to, or the one the root points at
	version: string
	repoUrl: string
	// git ref the source links point at
	ref: string
	cssHref: string
	jsHref: string
	// fonts the first paint needs, fetched alongside the stylesheet instead of after it
	fontPreloads: string[]
}

export type Heading = { depth: number; id: string; text: string }

const GITHUB_PATH =
	'M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.4-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z'

function GitHubMark({ className }: { className?: string }) {
	return (
		<svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="currentColor">
			<path d={GITHUB_PATH} />
		</svg>
	)
}

export function DocsDocument(props: {
	site: SiteInfo
	title: string
	description: string
	section: DS.SectionId | null
	sidebar: React.ReactNode
	children?: React.ReactNode
}) {
	const { site } = props
	return (
		<html lang="en" data-base={site.base} data-root={site.root} data-version={site.version}>
			<head>
				<meta charSet="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>{props.title}</title>
				<meta name="description" content={props.description} />
				<link rel="icon" href={`${site.root}favicon.svg`} type="image/svg+xml" />
				{site.fontPreloads.map((href) => (
					<link key={href} rel="preload" href={href} as="font" type="font/woff2" crossOrigin="" />
				))}
				<link rel="stylesheet" href={site.cssHref} />
				<script type="module" src={site.jsHref} />
			</head>
			<body>
				<a href="#content" className="docs-skip">
					Skip to content
				</a>
				<SiteHeader site={site} section={props.section} sidebar={props.sidebar} />
				{props.children}
				<SearchDialog />
			</body>
		</html>
	)
}

function SiteHeader({ site, section, sidebar }: { site: SiteInfo; section: DS.SectionId | null; sidebar: React.ReactNode }) {
	return (
		<header className="docs-header">
			<details className="docs-menu lg:hidden">
				<summary aria-label="Open navigation" className="docs-icon-btn">
					<Menu className="size-5" aria-hidden="true" />
				</summary>
				<div className="docs-menu-panel">
					<SectionNav site={site} section={section} />
					{sidebar}
				</div>
			</details>
			<a href={site.root} className="flex items-center gap-2.5 text-text no-underline">
				<LogoMark accent={null} className="size-7" />
				<span className="font-cond text-[15px] font-bold tracking-[0.14em] uppercase">Docs</span>
			</a>
			<button type="button" className="docs-search-btn" data-search-open="">
				<Search className="size-4" aria-hidden="true" />
				<span className="docs-search-label">Search the docs</span>
				<kbd className="docs-kbd max-sm:hidden">/</kbd>
			</button>
			<div className="ms-auto flex items-center gap-5">
				<div className="max-lg:hidden">
					<SectionNav site={site} section={section} />
				</div>
				<VersionMenu site={site} />
				<a href={site.repoUrl} className="docs-icon-btn" aria-label="SLM on GitHub">
					<GitHubMark className="size-5" />
				</a>
			</div>
		</header>
	)
}

// Lists every published version. The list comes from the site root's versions.json at runtime (docs-site.client.ts),
// because a released version's pages are never rebuilt and cannot know about later releases.
function VersionMenu({ site }: { site: SiteInfo }) {
	return (
		<details className="docs-version" data-version-menu="">
			<summary aria-label={`Documentation version: ${DS.versionLabel(site.version)}`}>
				{DS.versionLabel(site.version)}
				<ChevronDown className="size-3.5" aria-hidden="true" />
			</summary>
			<div className="docs-version-panel" data-version-list="">
				<a href={site.root}>All versions</a>
			</div>
		</details>
	)
}

function SectionNav({ site, section }: { site: SiteInfo; section: DS.SectionId | null }) {
	return (
		<nav aria-label="Sections" className="docs-sections">
			{DS.SECTIONS.map((s) => {
				const first = DS.pagesIn(s.id)[0]
				return (
					<a key={s.id} href={DS.pageHref(site, first)} aria-current={s.id === section ? 'page' : undefined}>
						{s.label}
					</a>
				)
			})}
		</nav>
	)
}

export function Sidebar({ site, page }: { site: SiteInfo; page: DS.Page }) {
	if (!DS.hasSidebar(page.section)) return null
	return (
		<nav aria-label="Pages" className="docs-sidebar">
			{DS.groupsIn(page.section).map((group) => (
				<div key={group.label} className="flex flex-col gap-0.5">
					<div className="docs-label px-2 pb-1.5">{group.label}</div>
					{group.pages.map((p) => (
						<a key={p.slug} href={DS.pageHref(site, p)} aria-current={p === page ? 'page' : undefined}>
							{p.label}
						</a>
					))}
				</div>
			))}
		</nav>
	)
}

export function DocPage(props: { site: SiteInfo; page: DS.Page; html: string; headings: Heading[] }) {
	const { site, page } = props
	const { prev, next } = DS.neighbours(page)
	const section = DS.SECTIONS.find((s) => s.id === page.section)!
	const toc = props.headings.filter((h) => h.depth >= 2 && h.depth <= 4)
	// indent from the page's shallowest section heading, so a page whose sections start at h3 is not indented under
	// an h2 it does not have
	const topDepth = Math.min(...toc.map((h) => h.depth))
	const hasSubheadings = toc.some((h) => h.depth > topDepth)
	return (
		<div className="docs-shell">
			{DS.hasSidebar(page.section) && (
				<div className="docs-sidebar-col max-lg:hidden">
					<Sidebar site={site} page={page} />
				</div>
			)}
			<main id="content" className="docs-main">
				<p className="docs-version-banner" data-version-banner="" hidden role="note" />
				<article className="docs-article" data-pagefind-body="">
					<div className="docs-label docs-crumbs" data-pagefind-ignore="">
						<span data-pagefind-filter="section">{section.label}</span>
						{page.group !== section.label && (
							<>
								<span aria-hidden="true">/</span>
								<span>{page.group}</span>
							</>
						)}
					</div>
					<div className="docs-prose" dangerouslySetInnerHTML={{ __html: props.html }} />
				</article>
				<footer className="docs-page-footer">
					<SourceLinks site={site} page={page} />
					{(prev || next) && (
						<nav aria-label="Previous and next" className="docs-pager">
							{prev ? (
								<a href={DS.pageHref(site, prev)}>
									<span className="docs-label flex items-center gap-1">
										<ChevronLeft className="size-3.5" aria-hidden="true" />
										Previous
									</span>
									<span className="font-semibold text-text">{prev.label}</span>
								</a>
							) : (
								<span />
							)}
							{next && (
								<a href={DS.pageHref(site, next)} className="items-end text-end">
									<span className="docs-label flex items-center gap-1">
										Next
										<ChevronRight className="size-3.5" aria-hidden="true" />
									</span>
									<span className="font-semibold text-text">{next.label}</span>
								</a>
							)}
						</nav>
					)}
				</footer>
			</main>
			<aside aria-label="On this page" className="docs-toc max-xl:hidden">
				{toc.length > 0 && (
					<>
						<div className="flex items-center justify-between pb-1">
							<div className="docs-label">On this page</div>
							{hasSubheadings && <TocToggle />}
						</div>
						{toc.map((h) => (
							<a key={h.id} href={`#${h.id}`} data-level={h.depth - topDepth}>
								{h.text}
							</a>
						))}
					</>
				)}
				<div className="mt-5 flex flex-col gap-2">
					<SourceLinkPair site={site} page={page} />
				</div>
			</aside>
		</div>
	)
}

// Collapses the table of contents to its top-level sections. Hidden until docs-site.client.ts runs, since it cannot
// work without it, and that script restores the reader's last choice.
function TocToggle() {
	return (
		<button
			type="button"
			className="docs-toc-toggle"
			data-toc-toggle=""
			aria-expanded="true"
			aria-label="Collapse subheadings"
			title="Collapse subheadings"
			hidden
		>
			<ChevronsDownUp className="docs-toc-collapse size-4" aria-hidden="true" />
			<ChevronsUpDown className="docs-toc-expand size-4" aria-hidden="true" />
		</button>
	)
}

function SourceLinks({ site, page }: { site: SiteInfo; page: DS.Page }) {
	return (
		<div className="docs-source">
			<code>{page.file}</code>
			<div className="ms-auto flex flex-wrap gap-x-5 gap-y-2">
				<SourceLinkPair site={site} page={page} />
			</div>
		</div>
	)
}

function SourceLinkPair({ site, page }: { site: SiteInfo; page: DS.Page }) {
	return (
		<>
			<a href={`${site.repoUrl}/blob/${site.ref}/${page.file}`} className="docs-quiet-link">
				<Code className="size-4" aria-hidden="true" />
				View source
			</a>
			{page.generatedBy ? (
				<a href={`${site.repoUrl}/tree/${site.ref}/${page.generatedBy}`} className="docs-quiet-link">
					<Pencil className="size-4" aria-hidden="true" />
					Generated from {page.generatedBy}
				</a>
			) : (
				<a href={`${site.repoUrl}/edit/main/${page.file}`} className="docs-quiet-link">
					<Pencil className="size-4" aria-hidden="true" />
					Edit on GitHub
				</a>
			)}
		</>
	)
}

// A heading with a link to itself, for copying the address of a section, and a link to the same heading in its
// markdown on GitHub. GitHub and rehype-slug derive heading ids the same way, so the id doubles as the GitHub anchor.
// Both links show on hover and keyboard focus.
export function SourceHeading(props: { level: 1 | 2 | 3 | 4 | 5 | 6; id?: string; sourceHref: string | null; children?: React.ReactNode }) {
	const Tag = `h${props.level}` as const
	return (
		<Tag id={props.id} className="docs-heading">
			{props.children}
			{props.id && props.level > 1 && (
				<a href={`#${props.id}`} className="docs-heading-link" aria-label="Link to this section" data-pagefind-ignore="">
					<LinkIcon className="size-3.5" aria-hidden="true" />
				</a>
			)}
			{props.sourceHref && props.level > 1 && (
				<a href={props.sourceHref} className="docs-heading-src" aria-label="View the source of this section" data-pagefind-ignore="">
					<Code className="size-3.5" aria-hidden="true" />
					source
				</a>
			)}
		</Tag>
	)
}

function SearchDialog() {
	return (
		<dialog id="docs-search" className="docs-search" aria-label="Search the docs">
			<form method="dialog" className="docs-search-field">
				<Search className="size-[18px] shrink-0 text-text-2" aria-hidden="true" />
				<label htmlFor="docs-search-input" className="sr-only">
					Search
				</label>
				<input
					id="docs-search-input"
					type="search"
					placeholder="Search the docs"
					autoComplete="off"
					spellCheck={false}
					role="combobox"
					aria-expanded="false"
					aria-controls="docs-search-results"
				/>
				<kbd className="docs-kbd">esc</kbd>
			</form>
			<ul id="docs-search-results" className="docs-search-results" role="listbox" aria-label="Results" />
			<p className="docs-search-status" aria-live="polite" />
			<div className="docs-search-keys" aria-hidden="true">
				<span>
					<kbd className="docs-kbd">↑</kbd> <kbd className="docs-kbd">↓</kbd> move
				</span>
				<span>
					<kbd className="docs-kbd">↵</kbd> open
				</span>
			</div>
		</dialog>
	)
}

// A landing highlight links to `page` (a markdown source in DS.PAGES), at the heading `anchor` when it names one.
export type Highlight = { title: string; text: string; page: string; anchor?: string }

export function LandingPage(props: {
	site: SiteInfo
	tagline: string
	description: string
	demoCommand: string
	youtubeId: string | null
	highlights: Highlight[]
}) {
	const { site } = props
	const features = DS.pagesIn('features')[0]
	return (
		<main id="content" className="docs-landing">
			<div className="flex max-w-[760px] flex-col gap-4">
				<h1 className="font-cond text-[44px] leading-[1.1] font-extrabold">Squad Layer Manager</h1>
				<p className="text-[21px] leading-[1.45] text-text">{props.tagline}</p>
				<p className="text-[16.5px] leading-[1.6] text-text-2">{props.description}</p>
				<div className="mt-1 flex flex-wrap gap-2.5">
					<a href={DS.pageHref(site, DS.pagesIn('guide')[0])} className="docs-btn docs-btn-primary">
						Setup guide
					</a>
					<a href={DS.pageHref(site, features)} className="docs-btn">
						Features
					</a>
					<a href={DS.pageHref(site, DS.pagesIn('developers')[0])} className="docs-btn">
						Developer docs
					</a>
				</div>
			</div>
			{props.youtubeId && <VideoFacade id={props.youtubeId} />}
			<ul className="docs-highlights">
				{props.highlights.map((h) => (
					<li key={h.title}>
						<a href={DS.pageHref(site, DS.PAGE_BY_FILE.get(h.page)!, h.anchor ? `#${h.anchor}` : '')}>
							<h2 className="font-cond text-[19px] font-bold text-text">{h.title}</h2>
							<p className="text-[15px] leading-normal text-text-2">{h.text}</p>
						</a>
					</li>
				))}
			</ul>
			<div className="flex max-w-[760px] flex-col gap-2.5">
				<h2 className="font-cond text-[22px] font-bold">Try it</h2>
				<p className="text-text-2">Run a demo instance with no authentication:</p>
				<CodeBlock className="docs-pre">
					<code>{props.demoCommand}</code>
				</CodeBlock>
			</div>
		</main>
	)
}

// A code block with a copy button. The button stays hidden until docs-site.client.ts runs, since it cannot work without it.
export function CodeBlock({ children, ...pre }: React.ComponentProps<'pre'>) {
	return (
		<div className="docs-code">
			<pre {...pre}>{children}</pre>
			<button type="button" className="docs-copy" data-copy="" aria-label="Copy code" hidden data-pagefind-ignore="">
				<Copy className="docs-copy-idle size-4" aria-hidden="true" />
				<Check className="docs-copy-done size-4" aria-hidden="true" />
			</button>
		</div>
	)
}

// A thumbnail that becomes the YouTube player on click, so no YouTube code loads before someone asks for it.
function VideoFacade({ id }: { id: string }) {
	return (
		<figure className="flex flex-col gap-2">
			<button
				type="button"
				className="docs-video"
				data-youtube-id={id}
				aria-label="Play video"
				style={{ backgroundImage: `url(https://i.ytimg.com/vi/${id}/hqdefault.jpg)` }}
			>
				<span className="docs-video-play" aria-hidden="true">
					<svg viewBox="0 0 24 24" className="size-7" fill="currentColor">
						<path d="M8 5v14l11-7z" />
					</svg>
				</span>
			</button>
			<figcaption className="text-[14px] text-text-2">
				<a href={`https://www.youtube.com/watch?v=${id}`} className="docs-quiet-link">
					Watch on YouTube
				</a>
			</figcaption>
		</figure>
	)
}

export function RedirectDocument({ to }: { to: string }) {
	return (
		<html lang="en">
			<head>
				<meta charSet="utf-8" />
				<meta httpEquiv="refresh" content={`0; url=${to}`} />
				<link rel="canonical" href={to} />
				<title>SLM Docs</title>
			</head>
			<body>
				<a href={to}>Continue to the documentation</a>
			</body>
		</html>
	)
}

export function NotFoundPage({ site }: { site: SiteInfo }) {
	return (
		<main id="content" className="docs-landing">
			<h1 className="font-cond text-[44px] font-extrabold">Page not found</h1>
			<p className="text-text-2">
				This page does not exist, or has moved. Try searching, or go to the <a href={site.root}>start page</a>.
			</p>
		</main>
	)
}
