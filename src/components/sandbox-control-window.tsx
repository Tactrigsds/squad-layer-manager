import * as Icons from 'lucide-react'
import React from 'react'

import ComboBoxMulti from '@/components/combo-box/combo-box-multi'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import * as SandboxFrame from '@/frames/sandbox.frame'
import { useDebounced } from '@/hooks/use-debounce'
import { toast } from '@/lib/toast'
import * as Zus from '@/lib/zustand'
import * as SB_Msgs from '@/messages/sandbox.messages'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import * as SB from '@/models/sandbox.models'
import { DraggableWindowStore } from '@/systems/draggable-window.client'

import type { SandboxControlWindowProps } from './sandbox-control-window.helpers'
import { SandboxAdminListPanel } from './sandbox-panels'
import { useOpenSandboxAdminListWindow } from './sandbox-panels.helpers'
import { ServerConsolePanel } from './server-console-panel'
import { useOpenServerConsoleWindow } from './server-console-window.helpers'
import { DraggableWindowClose, DraggableWindowDragBar, DraggableWindowTitle, useDraggableWindow } from './ui/draggable-window'
import { useSandboxFrame } from './use-sandbox-frame'
import { useServerConsoleFrame } from './use-server-console-frame'

DraggableWindowStore.getState().registerDefinition<SandboxControlWindowProps, unknown>({
	type: WINDOW_ID.enum['sandbox-control'],
	component: SandboxControlWindow,
	initialPosition: 'left',
	resizable: true,
	minWidth: 520,
	minHeight: 400,
	defaultWidth: 720,
	defaultHeight: 700,
	getId: (props) => `sandbox-control:${props.serverId}`,
})

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
	return (
		<section className="space-y-1.5">
			<div className="flex items-center gap-2">
				<h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
				{action && <div className="ml-auto">{action}</div>}
			</div>
			{children}
		</section>
	)
}

function SandboxControlWindow(props: SandboxControlWindowProps) {
	useDraggableWindow()
	const stores = useSandboxFrame(props.serverId)
	const [groupNames, nextName, playerCount, unavailable] = Zus.useStore(
		stores.sandbox,
		(s) =>
			[SandboxFrame.Sel.groupNames(s), SandboxFrame.Sel.nextDefaultName(s), SandboxFrame.Sel.players(s).length, s.unavailable] as const,
	)
	const full = playerCount >= SB.MAX_PLAYERS
	const joinRef = React.useRef<HTMLInputElement>(null)
	const bulkRef = React.useRef<HTMLInputElement>(null)
	const openAdminList = useOpenSandboxAdminListWindow({ serverId: props.serverId })
	const openConsole = useOpenServerConsoleWindow({ serverId: props.serverId })
	const consoleStores = useServerConsoleFrame(props.serverId)

	async function run<V extends SB.SandboxVerb>(verb: V, args: SB.SandboxVerbInput<V>) {
		const res = await SandboxFrame.Actions.run(stores, verb, args)
		if (res.code === 'ok') return true
		toast.error(...SB_Msgs.verbFailed('message' in res && res.message ? res.message : res.code).toast())
		return false
	}

	async function join() {
		const name = joinRef.current?.value.trim() || nextName
		if (await run('join', { name })) {
			if (joinRef.current) joinRef.current.value = ''
		}
	}

	async function bulkJoin() {
		const count = Number(bulkRef.current?.value ?? '')
		if (!Number.isInteger(count) || count < 1) {
			toast.error(...SB_Msgs.bulkJoinNeedsCount().toast())
			return
		}
		await run('bulk-join', { count })
	}

	if (unavailable) {
		return (
			<div className="min-w-0 min-h-0 flex-1 flex flex-col">
				<DraggableWindowDragBar>
					<DraggableWindowTitle>{SB_Msgs.windowTitle().text()}</DraggableWindowTitle>
					<DraggableWindowClose />
				</DraggableWindowDragBar>
				<p className="px-3 py-2 text-sm text-muted-foreground">{SB_Msgs.unavailable().text()}</p>
			</div>
		)
	}

	return (
		<div className="min-w-0 min-h-0 flex-1 flex flex-col">
			<DraggableWindowDragBar>
				<DraggableWindowTitle>{SB_Msgs.windowTitleFor(props.serverId).text()}</DraggableWindowTitle>
				<DraggableWindowClose />
			</DraggableWindowDragBar>
			<ScrollArea className="min-h-0 grow">
				<div className="space-y-4 px-3 py-2">
					<p className="text-xs text-muted-foreground">{SB_Msgs.blurb().text()}</p>

					<Section
						title={SB_Msgs.playersSection().text()}
						action={
							<div className="flex items-center gap-1.5">
								<Input
									ref={bulkRef}
									className="h-7 w-16"
									type="number"
									min={1}
									max={SB.MAX_PLAYERS}
									placeholder={SB_Msgs.bulkJoinCountPlaceholder().text()}
									disabled={full}
								/>
								<Button type="button" size="sm" variant="outline" className="h-7" disabled={full} onClick={() => void bulkJoin()}>
									{SB_Msgs.bulkJoin().text()}
								</Button>
							</div>
						}
					>
						<PlayersTable stores={stores} groupNames={groupNames} run={run} />
						<div className="flex items-center gap-1.5 pt-1">
							<Input
								ref={joinRef}
								className="h-8"
								placeholder={full ? SB_Msgs.serverFull(SB.MAX_PLAYERS).text() : nextName}
								disabled={full}
								onKeyDown={(e) => {
									if (e.key !== 'Enter') return
									e.preventDefault()
									void join()
								}}
							/>
							<Button type="button" size="sm" variant="outline" className="h-8" disabled={full} onClick={() => void join()}>
								<Icons.UserPlus className="mr-1 h-3.5 w-3.5" />
								{SB_Msgs.join().text()}
							</Button>
						</div>
					</Section>

					<ChatComposer stores={stores} run={run} />

					<Section title={SB_Msgs.matchSection().text()}>
						<div className="flex flex-wrap items-center gap-1.5">
							<Button
								type="button"
								size="sm"
								variant="outline"
								className="h-7"
								onClick={() => void run('end', { winnerTeamId: null })}
							>
								{SB_Msgs.endMatch().text()}
							</Button>
							<Button type="button" size="sm" variant="outline" className="h-7" onClick={() => void run('end', { winnerTeamId: 1 })}>
								{SB_Msgs.teamWins(1).text()}
							</Button>
							<Button type="button" size="sm" variant="outline" className="h-7" onClick={() => void run('end', { winnerTeamId: 2 })}>
								{SB_Msgs.teamWins(2).text()}
							</Button>
							<Button type="button" size="sm" variant="outline" className="h-7" onClick={() => void run('cycle', {})}>
								<Icons.Unplug className="mr-1 h-3.5 w-3.5" />
								{SB_Msgs.dropRcon().text()}
							</Button>
						</div>
					</Section>

					<Section
						title={SB_Msgs.adminListSection().text()}
						action={
							<Button type="button" size="sm" variant="ghost" className="h-7" onClick={() => openAdminList()}>
								<Icons.ExternalLink className="mr-1 h-3.5 w-3.5" />
								{SB_Msgs.popOut().text()}
							</Button>
						}
					>
						<SandboxAdminListPanel stores={stores} />
					</Section>

					<Section
						title={SB_Msgs.consoleSection().text()}
						action={
							<Button type="button" size="sm" variant="ghost" className="h-7" onClick={() => openConsole()}>
								<Icons.ExternalLink className="mr-1 h-3.5 w-3.5" />
								{SB_Msgs.popOut().text()}
							</Button>
						}
					>
						<ServerConsolePanel stores={consoleStores} className="h-64" />
					</Section>
				</div>
			</ScrollArea>
		</div>
	)
}

type RunFn = <V extends SB.SandboxVerb>(verb: V, args: SB.SandboxVerbInput<V>) => Promise<boolean>

// The admin checkbox and the group picker are two views of one membership: checking the box puts the player in the
// default admin group, and clearing it drops every group that would make them an admin. Nothing is stored twice.
function PlayersTable({ stores, groupNames, run }: { stores: SandboxFrame.KeyProp; groupNames: string[]; run: RunFn }) {
	const [{ players, page, pageCount, matched, total }, adminGroups] = Zus.useStore(
		stores.sandbox,
		(s) => [SandboxFrame.Sel.playersView(s), s.state?.groups ?? []] as const,
	)
	const identifying = new Set(adminGroups.filter((g) => g.permissions.includes('canseeadminchat')).map((g) => g.name))
	const defaultAdminGroup = [...identifying][0] ?? 'Admin'
	const onSearch = useDebounced<string>({
		delay: 200,
		onChange: (value) => SandboxFrame.Actions.setPlayerSearch(stores, value),
	})

	function setGroups(name: string, groups: string[]) {
		void run('set-player-groups', { name, groups })
	}

	if (total === 0) return <p className="text-sm text-muted-foreground">{SB_Msgs.nobodyConnected().text()}</p>

	return (
		<div className="space-y-1.5">
			<div className="flex items-center gap-1.5">
				<Input
					className="h-7"
					placeholder={SB_Msgs.searchPlayers().text()}
					aria-label={SB_Msgs.searchPlayersLabel().text()}
					onChange={(e) => onSearch(e.target.value)}
				/>
				<span className="whitespace-nowrap text-xs text-muted-foreground tabular-nums">
					{matched === total ? `${total}/${SB.MAX_PLAYERS}` : `${matched} of ${total}`}
				</span>
			</div>
			{matched === 0 ? (
				<p className="text-sm text-muted-foreground">{SB_Msgs.noPlayerMatches().text()}</p>
			) : (
				<>
					<div className="overflow-x-auto">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{SB_Msgs.playerColumn().text()}</TableHead>
									<TableHead className="w-14">{SB_Msgs.teamColumn().text()}</TableHead>
									<TableHead className="w-16">{SB_Msgs.squadColumn().text()}</TableHead>
									<TableHead className="w-16">{SB_Msgs.adminColumn().text()}</TableHead>
									<TableHead className="min-w-[12rem]">{SB_Msgs.groupsColumn().text()}</TableHead>
									<TableHead className="w-10" />
								</TableRow>
							</TableHeader>
							<TableBody>
								{players.map((p) => (
									<TableRow key={p.eosId}>
										<TableCell className="font-medium">{p.name}</TableCell>
										<TableCell className="text-muted-foreground">{p.teamId ?? '-'}</TableCell>
										<TableCell className="text-muted-foreground">{p.squadId ?? '-'}</TableCell>
										<TableCell>
											<Checkbox
												checked={p.isAdmin}
												aria-label={SB_Msgs.isAdminCheckbox(p.name).text()}
												onCheckedChange={(on) =>
													setGroups(
														p.name,
														on ? [...new Set([...p.groups, defaultAdminGroup])] : p.groups.filter((g) => !identifying.has(g)),
													)
												}
											/>
										</TableCell>
										<TableCell>
											<ComboBoxMulti
												title={SB_Msgs.groupPicker().text()}
												values={p.groups}
												options={groupNames}
												emptyLabel={SB_Msgs.noGroups().text()}
												chipDisplay
												onSelect={(next) => setGroups(p.name, typeof next === 'function' ? next(p.groups) : next)}
											/>
										</TableCell>
										<TableCell>
											<Button
												type="button"
												size="icon"
												variant="ghost"
												className="h-6 w-6"
												title={SB_Msgs.disconnectPlayer(p.name).text()}
												onClick={() => void run('leave', { name: p.name })}
											>
												<Icons.LogOut className="h-3.5 w-3.5" />
											</Button>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
					{pageCount > 1 && (
						<div className="flex items-center justify-end gap-1.5 text-xs text-muted-foreground">
							<Button
								type="button"
								size="icon"
								variant="ghost"
								className="h-6 w-6"
								aria-label={SB_Msgs.previousPage().text()}
								disabled={page === 0}
								onClick={() => SandboxFrame.Actions.setPlayerPage(stores, page - 1)}
							>
								<Icons.ChevronLeft className="h-3.5 w-3.5" />
							</Button>
							<span className="tabular-nums">
								{page + 1} / {pageCount}
							</span>
							<Button
								type="button"
								size="icon"
								variant="ghost"
								className="h-6 w-6"
								aria-label={SB_Msgs.nextPage().text()}
								disabled={page >= pageCount - 1}
								onClick={() => SandboxFrame.Actions.setPlayerPage(stores, page + 1)}
							>
								<Icons.ChevronRight className="h-3.5 w-3.5" />
							</Button>
						</div>
					)}
				</>
			)}
		</div>
	)
}

// Two selects and a message: who is speaking and on which channel. Admin chat is offered only to admins, because a
// real server does not carry a non-admin's words into it.
function ChatComposer({ stores, run }: { stores: SandboxFrame.KeyProp; run: RunFn }) {
	const [speaker, channels, channel] = Zus.useStore(
		stores.sandbox,
		(s) =>
			[SandboxFrame.Sel.activeSpeaker(s), SandboxFrame.Sel.availableChatChannels(s), SandboxFrame.Sel.effectiveChatChannel(s)] as const,
	)
	const players = Zus.useStore(stores.sandbox, SandboxFrame.Sel.players)
	const messageRef = React.useRef<HTMLInputElement>(null)

	async function send() {
		const message = messageRef.current?.value.trim()
		if (!message || !speaker) return
		if (await run('chat', { name: speaker.name, message, channel })) {
			if (messageRef.current) messageRef.current.value = ''
		}
	}

	return (
		<Section title={SB_Msgs.saySection().text()}>
			<div className="flex items-center gap-1.5">
				<Select
					value={speaker?.name ?? undefined}
					onValueChange={(name) => SandboxFrame.Actions.setSpeaker(stores, name)}
					disabled={players.length === 0}
				>
					<SelectTrigger className="h-8 w-[9rem]">
						<SelectValue placeholder={SB_Msgs.speakerPlaceholder().text()} />
					</SelectTrigger>
					<SelectContent>
						{players.map((p) => (
							<SelectItem key={p.eosId} value={p.name}>
								{p.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Select
					value={channel}
					onValueChange={(c) => SandboxFrame.Actions.setChatChannel(stores, c as SB.PlayerChatChannel)}
					disabled={players.length === 0}
				>
					<SelectTrigger className="h-8 w-[8.5rem]">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{channels.map((c) => (
							<SelectItem key={c} value={c}>
								{c}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Input
					ref={messageRef}
					className="h-8"
					placeholder={SB_Msgs.messagePlaceholder().text()}
					disabled={players.length === 0}
					onKeyDown={(e) => {
						if (e.key !== 'Enter') return
						e.preventDefault()
						void send()
					}}
				/>
				<Button type="button" size="sm" variant="outline" className="h-8" disabled={players.length === 0} onClick={() => void send()}>
					{SB_Msgs.send().text()}
				</Button>
			</div>
			{players.length > 0 && !speaker?.isAdmin && (
				<p className="text-xs text-muted-foreground">{SB_Msgs.adminChatNeedsAdmin().text()}</p>
			)}
		</Section>
	)
}
