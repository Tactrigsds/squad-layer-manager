// The documentation site's pages, rendered to static HTML by src/scripts/build-docs.ts and never mounted in the app.
// The only script a page loads is docs-site.client.ts, for search and the video facade.
import {
	ArrowRight,
	Check,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	ChevronsDownUp,
	ChevronsUpDown,
	Code,
	Copy,
	Heart,
	Link as LinkIcon,
	Menu,
	Pencil,
	Search,
} from 'lucide-react'
import * as React from 'react'

import LogoMark from '@/components/logo-mark'
import { assertNever } from '@/lib/type-guards'
import * as DS from '@/models/docs-site.models'
import * as Project from '@/models/project.models'

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

const DISCORD_PATH =
	'M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z'

function DiscordMark({ className }: { className?: string }) {
	return (
		<svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="currentColor">
			<path d={DISCORD_PATH} />
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
					<div className="flex flex-wrap items-center gap-3 sm:hidden">
						<VersionMenu site={site} className="" />
						<SupportLink className="" />
					</div>
				</div>
			</details>
			<a href={site.root} className="flex items-center gap-2.5 text-text no-underline">
				<LogoMark accent={null} className="size-7" />
				<span className="font-cond text-[15px] font-bold tracking-[0.14em] uppercase">Docs</span>
			</a>
			<VersionMenu site={site} className="max-sm:hidden" />
			<button type="button" className="docs-search-btn" data-search-open="">
				<Search className="size-4" aria-hidden="true" />
				<span className="docs-search-label">Search the docs</span>
				<kbd className="docs-kbd max-sm:hidden">/</kbd>
			</button>
			<div className="ms-auto flex items-center gap-5">
				<div className="max-lg:hidden">
					<SectionNav site={site} section={section} />
				</div>
				<div className="flex items-center gap-1">
					<SupportLink className="me-1 max-sm:hidden" />
					<a href={Project.DISCORD_URL} className="docs-icon-btn" aria-label="SLM on Discord">
						<DiscordMark className="size-5" />
					</a>
					<a href={site.repoUrl} className="docs-icon-btn" aria-label="SLM on GitHub">
						<GitHubMark className="size-5" />
					</a>
				</div>
			</div>
		</header>
	)
}

// SupportLink and VersionMenu are shown in the header from 640px up, and in the navigation menu below that, where the
// header has no room for them.
function SupportLink({ className }: { className: string }) {
	return (
		<a href={Project.DONATION_URL} className={`docs-support-btn ${className}`} aria-label="Support SLM on Ko-fi">
			<Heart className="size-4 text-pri" aria-hidden="true" />
			Support
		</a>
	)
}

// Lists every published version. The list comes from the site root's versions.json at runtime (docs-site.client.ts),
// because a released version's pages are never rebuilt and cannot know about later releases.
function VersionMenu({ site, className }: { site: SiteInfo; className: string }) {
	return (
		<details className={`docs-version ${className}`} data-version-menu="">
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
export type Highlight = {
	title: string
	text: string
	page: string
	anchor?: string
	// the text of the link under the blurb, naming where it goes
	linkLabel: string
	media: HighlightMedia
}

// `shot` is a repo-relative screenshot. `crop` is the window of it the card shows, in the screenshot's CSS pixels, and
// defaults to the top-left corner, zoomed in far enough to read (see defaultCrop).
export type HighlightMedia = { kind: 'shot'; file: string; alt: string; crop?: Crop } | { kind: 'docker' }

// a highlight as the landing page renders it: a screenshot carries its size, read from the file at build time
export type SizedHighlight = Omit<Highlight, 'media'> & {
	media: Exclude<HighlightMedia, { kind: 'shot' }> | (Extract<HighlightMedia, { kind: 'shot' }> & { size: Size })
}

type Crop = { x: number; y: number; width: number }
type Size = { width: number; height: number }

const SHOT_ASPECT = 16 / 10
const DEFAULT_CROP_WIDTH = 560

function defaultCrop(size: Size): Crop {
	return { x: 0, y: 0, width: Math.min(DEFAULT_CROP_WIDTH, size.width, size.height * SHOT_ASPECT) }
}

const DOCKER_PATH =
	'M13.983 11.078h2.119a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.119a.185.185 0 00-.185.185v1.888c0 .102.083.185.185.185m-2.954-5.43h2.118a.186.186 0 00.186-.186V3.574a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m0 2.716h2.118a.187.187 0 00.186-.186V6.29a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.887c0 .102.082.185.185.186m-2.93 0h2.12a.186.186 0 00.184-.186V6.29a.185.185 0 00-.185-.185H8.1a.185.185 0 00-.185.185v1.887c0 .102.083.185.185.186m-2.964 0h2.119a.186.186 0 00.185-.186V6.29a.185.185 0 00-.185-.185H5.136a.186.186 0 00-.186.185v1.887c0 .102.084.185.186.186m5.893 2.715h2.118a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m-2.93 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.083.185.185.185m-2.964 0h2.119a.185.185 0 00.185-.185V9.006a.185.185 0 00-.184-.186h-2.12a.186.186 0 00-.186.186v1.887c0 .102.084.185.186.185m-2.92 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.082.185.185.185M23.763 9.89c-.065-.051-.672-.51-1.954-.51-.338.001-.676.03-1.01.087-.248-1.7-1.653-2.53-1.716-2.566l-.344-.199-.226.327c-.284.438-.49.922-.612 1.43-.23.97-.09 1.882.403 2.661-.595.332-1.55.413-1.744.42H.751a.751.751 0 00-.75.748 11.376 11.376 0 00.692 4.062c.545 1.428 1.355 2.48 2.41 3.124 1.18.723 3.1 1.137 5.275 1.137.983.003 1.963-.086 2.93-.266a12.248 12.248 0 003.823-1.389c.98-.567 1.86-1.288 2.61-2.136 1.252-1.418 1.998-2.997 2.553-4.4h.221c1.372 0 2.215-.549 2.68-1.009.309-.293.55-.65.707-1.046l.098-.288Z'

function HighlightVisual({ site, media }: { site: SiteInfo; media: SizedHighlight['media'] }) {
	switch (media.kind) {
		case 'shot': {
			// The image is scaled so the crop's width fills the frame, then shifted to the crop's corner. Percentage margins
			// are relative to the frame's width, which is what the crop's width maps to, so one unit serves both axes.
			const crop = media.crop ?? defaultCrop(media.size)
			const pct = (n: number) => `${(n / crop.width) * 100}%`
			return (
				<div className="docs-highlight-shot">
					<img
						src={DS.assetHref(site.assetBase, media.file)}
						alt={media.alt}
						loading="lazy"
						decoding="async"
						style={{ width: pct(media.size.width), marginLeft: pct(-crop.x), marginTop: pct(-crop.y) }}
					/>
				</div>
			)
		}
		case 'docker':
			return (
				<div className="docs-highlight-shot docs-highlight-icon">
					<svg viewBox="0 0 24 24" role="img" aria-label="Docker" fill="#2496ed" className="w-2/5">
						<path d={DOCKER_PATH} />
					</svg>
				</div>
			)
		default:
			assertNever(media)
	}
}

export function LandingPage(props: {
	site: SiteInfo
	tagline: string
	description: string
	demoCommand: string
	youtubeId: string | null
	highlights: SizedHighlight[]
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
						<HighlightVisual site={site} media={h.media} />
						<div className="flex flex-col items-start gap-1.5">
							<h2 className="font-cond text-[22px] font-bold text-text">{h.title}</h2>
							<p className="text-[15.5px] leading-normal text-text-2">{h.text}</p>
							<a
								href={DS.pageHref(site, DS.PAGE_BY_FILE.get(h.page)!, h.anchor ? `#${h.anchor}` : '')}
								className="mt-1 inline-flex items-center gap-1 text-[15px] font-semibold"
							>
								{h.linkLabel}
								<ArrowRight className="size-4 rtl:-scale-x-100" aria-hidden="true" />
							</a>
						</div>
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
				<title>{DS.tabTitle(null)}</title>
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
