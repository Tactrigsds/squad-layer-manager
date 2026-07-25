import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import type * as SB from '@/models/sandbox.models'
import { DraggableWindowStore } from '@/systems/draggable-window.client'
import * as SandboxClient from '@/systems/sandbox.client'
import * as Icons from 'lucide-react'
import React from 'react'
import type { SandboxControlWindowProps } from './sandbox-control-window.helpers'
import { DraggableWindowClose, DraggableWindowDragBar, DraggableWindowTitle, useDraggableWindow } from './ui/draggable-window'

DraggableWindowStore.getState().registerDefinition<SandboxControlWindowProps, unknown>({
	type: WINDOW_ID.enum['sandbox-control'],
	component: SandboxControlWindow,
	initialPosition: 'left',
	resizable: true,
	minWidth: 380,
	minHeight: 340,
	defaultWidth: 460,
	defaultHeight: 620,
	getId: (props) => `sandbox-control:${props.serverId}`,
})

function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<section className="space-y-1.5">
			<h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
			{children}
		</section>
	)
}

function SandboxControlWindow(props: SandboxControlWindowProps) {
	useDraggableWindow()
	const serverId = props.serverId
	const playersRes = SandboxClient.useSandboxPlayers(serverId)
	const execute = SandboxClient.useExecuteMutation()

	const players = playersRes.data?.code === 'ok' ? playersRes.data.players : []
	const [log, setLog] = React.useState<SandboxClient.ExecuteResult[]>([])
	// the puppet every "speak as" action is attributed to. Held rather than read off the select so it survives the
	// roster refetch that follows each join.
	const [speaker, setSpeaker] = React.useState<string | null>(null)
	const joinRef = React.useRef<HTMLInputElement>(null)
	const messageRef = React.useRef<HTMLInputElement>(null)
	const rconRef = React.useRef<HTMLInputElement>(null)

	const activeSpeaker = speaker && players.some((p) => p.name === speaker) ? speaker : players[0]?.name ?? null

	async function run<V extends SB.SandboxVerb>(verb: V, args: unknown) {
		const res = await execute.mutateAsync({ serverId, verb, args })
		const ok = res.code === 'ok'
		const text = res.code === 'ok'
			? res.output
			: 'message' in res && res.message
			? res.message
			: res.code
		setLog((prev) => [{ verb, ok, text }, ...prev].slice(0, 50))
		if (ok) await SandboxClient.invalidatePlayers(serverId)
		return ok
	}

	async function join() {
		const name = joinRef.current?.value.trim()
		if (!name) return
		if (await run('join', { name })) {
			joinRef.current!.value = ''
			setSpeaker(name)
		}
	}

	async function say(channel: 'chat' | 'admchat') {
		const message = messageRef.current?.value.trim()
		if (!message || !activeSpeaker) return
		if (await run(channel, { name: activeSpeaker, message })) messageRef.current!.value = ''
	}

	async function runRcon() {
		const command = rconRef.current?.value.trim()
		if (!command) return
		if (await run('rcon', { command })) rconRef.current!.value = ''
	}

	return (
		<div className="min-w-0 min-h-0 flex-1 flex flex-col">
			<DraggableWindowDragBar>
				<DraggableWindowTitle>Sandbox: {serverId}</DraggableWindowTitle>
				<DraggableWindowClose />
			</DraggableWindowDragBar>
			<ScrollArea className="min-h-0 grow">
				<div className="space-y-4 px-3 py-2">
					<p className="text-xs text-muted-foreground">
						This server is emulated. Players here are fabricated and nothing said or done reaches anyone real.
					</p>

					<Section title="Players">
						{players.length === 0
							? <p className="text-sm text-muted-foreground">Nobody connected.</p>
							: (
								<ul className="space-y-1">
									{players.map((p) => (
										<li key={p.eosId} className="flex items-center gap-2 rounded-md border px-2 py-1 text-sm">
											<span className="font-medium truncate">{p.name}</span>
											<span className="text-xs text-muted-foreground">
												team {p.teamId ?? '-'} &middot; squad {p.squadId ?? '-'}
											</span>
											<Button
												type="button"
												size="icon"
												variant="ghost"
												className="ml-auto h-6 w-6"
												title={`Disconnect ${p.name}`}
												onClick={() => void run('leave', { name: p.name })}
											>
												<Icons.LogOut className="h-3.5 w-3.5" />
											</Button>
										</li>
									))}
								</ul>
							)}
						<div className="flex items-center gap-1.5">
							<Input
								ref={joinRef}
								className="h-8"
								placeholder="name to connect"
								onKeyDown={(e) => {
									if (e.key !== 'Enter') return
									e.preventDefault()
									void join()
								}}
							/>
							<Button type="button" size="sm" variant="outline" className="h-8" onClick={() => void join()}>
								<Icons.UserPlus className="mr-1 h-3.5 w-3.5" />
								Join
							</Button>
						</div>
					</Section>

					<Section title="Say">
						<div className="flex items-center gap-1.5">
							<Select value={activeSpeaker ?? undefined} onValueChange={setSpeaker} disabled={players.length === 0}>
								<SelectTrigger className="h-8 w-[9rem]">
									<SelectValue placeholder="as..." />
								</SelectTrigger>
								<SelectContent>
									{players.map((p) => <SelectItem key={p.eosId} value={p.name}>{p.name}</SelectItem>)}
								</SelectContent>
							</Select>
							<Input
								ref={messageRef}
								className="h-8"
								placeholder="!vote 1"
								disabled={players.length === 0}
								onKeyDown={(e) => {
									if (e.key !== 'Enter') return
									e.preventDefault()
									void say('chat')
								}}
							/>
						</div>
						<div className="flex items-center gap-1.5">
							<Button
								type="button"
								size="sm"
								variant="outline"
								className="h-7"
								disabled={players.length === 0}
								onClick={() => void say('chat')}
							>
								All chat
							</Button>
							<Button
								type="button"
								size="sm"
								variant="outline"
								className="h-7"
								disabled={players.length === 0}
								onClick={() => void say('admchat')}
							>
								Admin chat
							</Button>
							<Button
								type="button"
								size="sm"
								variant="ghost"
								className="h-7"
								disabled={!activeSpeaker}
								onClick={() => void run('squad', { name: activeSpeaker, squadName: `${activeSpeaker}'s squad` })}
							>
								Make squad
							</Button>
						</div>
					</Section>

					<Section title="Match">
						<div className="flex flex-wrap items-center gap-1.5">
							<Button type="button" size="sm" variant="outline" className="h-7" onClick={() => void run('end', {})}>
								End match
							</Button>
							<Button type="button" size="sm" variant="outline" className="h-7" onClick={() => void run('end', { winnerTeamId: 1 })}>
								Team 1 wins
							</Button>
							<Button type="button" size="sm" variant="outline" className="h-7" onClick={() => void run('end', { winnerTeamId: 2 })}>
								Team 2 wins
							</Button>
						</div>
					</Section>

					<Section title="Faults">
						<Button type="button" size="sm" variant="outline" className="h-7" onClick={() => void run('cycle', {})}>
							<Icons.Unplug className="mr-1 h-3.5 w-3.5" />
							Drop and restore RCON
						</Button>
					</Section>

					<Section title="Raw RCON">
						<div className="flex items-center gap-1.5">
							<Input
								ref={rconRef}
								className="h-8 font-mono text-xs"
								placeholder="ListPlayers"
								onKeyDown={(e) => {
									if (e.key !== 'Enter') return
									e.preventDefault()
									void runRcon()
								}}
							/>
							<Button type="button" size="sm" variant="outline" className="h-8" onClick={() => void runRcon()}>
								Run
							</Button>
						</div>
					</Section>

					{log.length > 0 && (
						<Section title="Output">
							<ol className="space-y-1">
								{log.map((entry, i) => (
									// oxlint-disable-next-line no-array-index-key
									<li key={i} className="flex items-start gap-1.5 text-xs">
										<code className="shrink-0 text-muted-foreground">{entry.verb}</code>
										<pre className={`min-w-0 whitespace-pre-wrap font-mono ${entry.ok ? '' : 'text-destructive'}`}>{entry.text}</pre>
									</li>
								))}
							</ol>
						</Section>
					)}
				</div>
			</ScrollArea>
		</div>
	)
}
