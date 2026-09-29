import { useQuery } from '@tanstack/react-query'
import * as TSR from '@tanstack/react-router'
import * as Icons from 'lucide-react'
import React from 'react'
import Markdown, { type Components } from 'react-markdown'

import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import * as ChangelogFrame from '@/frames/changelog.frame'
import { useFrameLifecycle, useFrameTeardownOnUnmount } from '@/frames/frame-manager'
import { useDebounced } from '@/hooks/use-debounce'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as CL_Msgs from '@/messages/changelog.messages'
import type * as CL from '@/models/changelog.models'
import * as ChangelogClient from '@/systems/changelog.client'
import { tr } from '@/systems/messages.client'

// The What's new page: every release this build ships, newest first, with the changes not yet in a release on top.
// Anchors are `#release-<version>` for a release and `#<entry id>` for one change, so either can be linked to.

const RELEASE_DATE = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' })

function releaseAnchor(version: string | null) {
	return `release-${version ?? 'unreleased'}`
}

function formatDate(date: string) {
	return RELEASE_DATE.format(new Date(`${date}T00:00:00Z`))
}

// an entry's text is markdown written by us, so its links leave the app in a new tab
const BODY_COMPONENTS: Components = {
	a: (p) => (
		<a href={p.href} target="_blank" rel="noopener noreferrer">
			{p.children}
		</a>
	),
}
// a title is one line: its paragraph is unwrapped, and only inline markup survives
const TITLE_COMPONENTS: Components = { ...BODY_COMPONENTS, p: (p) => p.children }
const TITLE_ELEMENTS = ['p', 'code', 'strong', 'em', 'a']

function Title(props: { text: string }) {
	return (
		<Markdown components={TITLE_COMPONENTS} allowedElements={TITLE_ELEMENTS} unwrapDisallowed>
			{props.text}
		</Markdown>
	)
}

// The page renders after its data arrives, so the browser's own jump to the fragment has already missed. Stable, so
// React calls it once when the linked entry mounts rather than on every render.
function scrollToLinked(el: HTMLElement | null) {
	el?.scrollIntoView({ block: 'center' })
}

export default function ChangelogPage() {
	const frameKey = useFrameLifecycle(ChangelogFrame.frame, { input: {} })
	useFrameTeardownOnUnmount(frameKey)
	return <ChangelogView stores={{ changelog: frameKey }} />
}

function ChangelogView(props: { stores: ChangelogFrame.KeyProp }) {
	const loaded = Zus.useStore(props.stores.changelog, (s) => s.data !== null)
	const failed = Zus.useStore(props.stores.changelog, (s) => s.failed)
	const releases = Zus.useStore(props.stores.changelog, ChangelogFrame.Sel.visibleReleases)
	const searching = Zus.useStore(props.stores.changelog, (s) => s.query.trim() !== '')

	return (
		<div className="mx-auto flex w-full max-w-5xl gap-12 px-4 py-6">
			<main className="flex min-w-0 grow flex-col gap-5">
				<Header stores={props.stores} />
				{failed && <p className="text-sm text-muted-foreground">{tr.text(CL_Msgs.loadFailed())}</p>}
				{!loaded && !failed && <Spinner />}
				{releases.length > 1 && <JumpTo releases={releases} />}
				{loaded && releases.length === 0 && (
					<p className="text-sm text-muted-foreground">{tr.text(searching ? CL_Msgs.noMatches() : CL_Msgs.empty())}</p>
				)}
				{releases.map((release) => (
					<ReleaseSection key={releaseAnchor(release.version)} release={release} />
				))}
			</main>
			{releases.length > 1 && <ReleaseRail releases={releases} />}
		</div>
	)
}

function Header(props: { stores: ChangelogFrame.KeyProp }) {
	const version = Zus.useStore(props.stores.changelog, ChangelogFrame.Sel.latestVersion)
	const pending = Zus.useStore(props.stores.changelog, ChangelogFrame.Sel.pendingCount)
	const loaded = Zus.useStore(props.stores.changelog, (s) => s.data !== null)
	const showOps = Zus.useStore(props.stores.changelog, (s) => s.showOps)
	const status = useQuery(ChangelogClient.statusQueryOptions)
	const onSearch = useDebounced<string>({
		delay: 150,
		onChange: React.useCallback((query: string) => ChangelogFrame.Actions.setQuery(props.stores, query), [props.stores]),
	})
	const opsId = React.useId()
	const notifyId = React.useId()

	return (
		<header className="flex flex-col gap-4">
			<div className="flex flex-col gap-1">
				<h1 className="fd-cond text-3xl font-bold">{tr.text(CL_Msgs.pageTitle())}</h1>
				{loaded && version && <p className="text-sm text-muted-foreground">{tr.text(CL_Msgs.runningVersion(version, pending))}</p>}
			</div>
			<div className="flex flex-wrap items-center gap-x-6 gap-y-3">
				<div className="relative w-full sm:w-80">
					<Input
						type="search"
						className="pl-9"
						placeholder={tr.text(CL_Msgs.searchPlaceholder())}
						aria-label={tr.text(CL_Msgs.searchPlaceholder())}
						onChange={(e) => onSearch(e.target.value)}
					/>
					{/* after the input so it paints over the input's background */}
					<Icons.Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
				</div>
				<div className="flex items-center gap-2">
					<Switch
						id={opsId}
						checked={showOps}
						onCheckedChange={(checked) => ChangelogFrame.Actions.setShowOps(props.stores, checked)}
					/>
					<Label htmlFor={opsId}>{tr.text(CL_Msgs.operatorNotes())}</Label>
				</div>
				<div className="flex items-center gap-2">
					<Switch
						id={notifyId}
						disabled={!status.data}
						checked={status.data?.notify ?? true}
						onCheckedChange={(checked) => void ChangelogClient.Actions.setNotify(checked)}
					/>
					<Label htmlFor={notifyId}>{tr.text(CL_Msgs.notifyMe())}</Label>
				</div>
			</div>
		</header>
	)
}

function ReleaseSection(props: { release: ChangelogFrame.VisibleRelease }) {
	const { release } = props
	const operators = [...release.headline.operators, ...release.minor.operators]
	return (
		<section
			id={releaseAnchor(release.version)}
			aria-labelledby={`${releaseAnchor(release.version)}-title`}
			className="scroll-mt-4 rounded-md border bg-card"
		>
			<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b px-5 py-4">
				<h2 id={`${releaseAnchor(release.version)}-title`} className="fd-cond text-xl font-bold">
					{release.version ?? tr.text(CL_Msgs.notYetReleased())}
				</h2>
				<span className="text-sm text-muted-foreground">
					{release.date ? formatDate(release.date) : tr.text(CL_Msgs.notYetReleasedBlurb())}
				</span>
				{release.unseenCount > 0 && (
					<span className="ml-auto rounded-full bg-primary/15 px-2 py-0.5 text-xs font-semibold text-primary">
						{tr.text(CL_Msgs.newCount(release.unseenCount))}
					</span>
				)}
			</div>
			{(release.headline.users.length > 0 || release.minor.users.length > 0) && (
				<div className="flex flex-col gap-1 px-5 py-3">
					<EntryList entries={release.headline.users} />
					<MinorEntries entries={release.minor.users} />
				</div>
			)}
			{operators.length > 0 && (
				<div className="flex flex-col gap-2 border-t px-5 py-3">
					<h3 className="fd-cond text-xs font-bold tracking-wider uppercase">{tr.text(CL_Msgs.forOperators())}</h3>
					<EntryList entries={operators} />
				</div>
			)}
		</section>
	)
}

function MinorEntries(props: { entries: ChangelogFrame.VisibleEntry[] }) {
	const hash = TSR.useLocation({ select: (location) => location.hash })
	if (props.entries.length === 0) return null
	return (
		<Collapsible className="pl-26 max-sm:pl-0" defaultOpen={props.entries.some((entry) => entry.id === hash)}>
			<CollapsibleTrigger className="group flex items-center gap-1.5 py-1 text-sm text-muted-foreground hover:text-foreground">
				<Icons.ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90" />
				{tr.text(CL_Msgs.smallerChanges(props.entries.length))}
			</CollapsibleTrigger>
			<CollapsibleContent>
				<ul className="mt-1 flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
					{props.entries.map((entry) => (
						<li
							key={entry.id}
							id={entry.id}
							ref={entry.id === hash ? scrollToLinked : undefined}
							className="scroll-mt-4 target:text-foreground [&_code]:font-mono"
						>
							<Title text={entry.title} />
						</li>
					))}
				</ul>
			</CollapsibleContent>
		</Collapsible>
	)
}

function EntryList(props: { entries: ChangelogFrame.VisibleEntry[] }) {
	const hash = TSR.useLocation({ select: (location) => location.hash })
	if (props.entries.length === 0) return null
	return (
		<ul className="flex flex-col">
			{props.entries.map((entry) => (
				<EntryRow key={entry.id} entry={entry} linkedTo={hash === entry.id} />
			))}
		</ul>
	)
}

const KIND_CLASS: Record<CL.Kind, string> = {
	added: 'text-muted-foreground',
	changed: 'text-muted-foreground',
	fixed: 'text-muted-foreground',
	removed: 'text-muted-foreground',
	breaking: 'text-destructive',
}

function EntryRow(props: { entry: ChangelogFrame.VisibleEntry; linkedTo: boolean }) {
	const { entry } = props
	return (
		<li
			id={entry.id}
			ref={props.linkedTo ? scrollToLinked : undefined}
			className="group/entry -mx-3 grid scroll-mt-4 grid-cols-[5.5rem_minmax(0,1fr)_auto] items-start gap-x-4 rounded-sm px-3 py-2 target:bg-primary/10 target:ring-1 target:ring-primary max-sm:grid-cols-[minmax(0,1fr)_auto]"
		>
			<span className={cn('fd-cond pt-0.5 text-xs font-semibold tracking-wider uppercase max-sm:col-span-2', KIND_CLASS[entry.kind])}>
				{tr.text(CL_Msgs.kinds[entry.kind]())}
			</span>
			<div className="flex min-w-0 flex-col gap-1.5">
				<div className="flex items-baseline gap-2.5">
					{entry.unseen && (
						<span
							role="img"
							aria-label={tr.text(CL_Msgs.newEntry())}
							className="size-1.5 shrink-0 translate-y-[-2px] rounded-full bg-primary"
						/>
					)}
					<span className="[&_code]:font-mono">
						<Title text={entry.title} />
					</span>
				</div>
				{entry.body && (
					<div className="text-sm text-muted-foreground [&_a]:underline [&_code]:font-mono [&_ol]:list-decimal [&_ol]:pl-5 [&_p+p]:mt-2 [&_ul]:list-disc [&_ul]:pl-5">
						<Markdown components={BODY_COMPONENTS}>{entry.body}</Markdown>
					</div>
				)}
				{entry.tutorial && (
					<Button asChild size="sm" variant="secondary" className="self-start">
						<TSR.Link to="/tutorials">
							{tr.text(CL_Msgs.tryTutorial())}
							<Icons.ArrowRight />
						</TSR.Link>
					</Button>
				)}
			</div>
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label={tr.text(CL_Msgs.copyLink())}
				className="opacity-0 group-hover/entry:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
				onClick={() => void copyEntryLink(entry.id)}
			>
				<Icons.Link />
			</Button>
		</li>
	)
}

async function copyEntryLink(id: string) {
	const url = new URL(window.location.href)
	url.search = ''
	url.hash = id
	await navigator.clipboard.writeText(url.toString())
	toast(tr.text(CL_Msgs.linkCopied()))
}

function releaseLabel(release: ChangelogFrame.VisibleRelease) {
	return release.version ?? tr.text(CL_Msgs.notYetReleasedShort())
}

function ReleaseRail(props: { releases: ChangelogFrame.VisibleRelease[] }) {
	return (
		<nav aria-label={tr.text(CL_Msgs.releasesHeading())} className="sticky top-6 hidden w-48 shrink-0 self-start lg:block">
			<h2 className="fd-cond mb-2 text-xs font-bold tracking-wider text-muted-foreground uppercase">
				{tr.text(CL_Msgs.releasesHeading())}
			</h2>
			<ul className="flex flex-col gap-0.5">
				{props.releases.map((release) => (
					<li key={releaseAnchor(release.version)}>
						<TSR.Link
							to="."
							hash={releaseAnchor(release.version)}
							className="flex items-center gap-2 rounded-sm px-2.5 py-1.5 text-sm hover:bg-accent"
						>
							<span className="grow">{releaseLabel(release)}</span>
							{release.unseenCount > 0 ? (
								<span role="img" aria-label={tr.text(CL_Msgs.newEntry())} className="size-1.5 rounded-full bg-primary" />
							) : (
								release.date && <span className="text-xs text-muted-foreground">{formatDate(release.date)}</span>
							)}
						</TSR.Link>
					</li>
				))}
			</ul>
		</nav>
	)
}

// the rail's stand-in below the lg breakpoint
function JumpTo(props: { releases: ChangelogFrame.VisibleRelease[] }) {
	const navigate = TSR.useNavigate()
	const id = React.useId()
	return (
		<div className="flex items-center gap-2 lg:hidden">
			<Label htmlFor={id} className="text-sm text-muted-foreground">
				{tr.text(CL_Msgs.jumpTo())}
			</Label>
			<select
				id={id}
				className="h-9 grow rounded-sm border bg-background px-2 text-sm"
				onChange={(e) => void navigate({ to: '.', hash: e.target.value })}
			>
				{props.releases.map((release) => (
					<option key={releaseAnchor(release.version)} value={releaseAnchor(release.version)}>
						{releaseLabel(release)}
					</option>
				))}
			</select>
		</div>
	)
}
