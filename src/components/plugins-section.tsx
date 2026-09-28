import * as Icons from 'lucide-react'
import React from 'react'
import { toast } from 'sonner'

import ComboBoxMulti from '@/components/combo-box/combo-box-multi'
import type SchemaYamlEditorComponent from '@/components/schema-yaml-editor'
import type { SchemaYamlEditorHandle } from '@/components/schema-yaml-editor.types'
import SettingsForm, { HelpTip } from '@/components/settings-form'
import { SettingsChangeList } from '@/components/settings-save-panel'
import { YamlEditorToolbar } from '@/components/settings-yaml-toolbar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAlertDialog } from '@/components/ui/lazy-alert-dialog'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import * as SettingsEditorFrame from '@/frames/settings-editor.frame'
import { cn } from '@/lib/utils'
import type { z } from '@/lib/zod'
import * as Zus from '@/lib/zustand'
import * as CMD_Msgs from '@/messages/command.messages'
import * as PLUGINS_Msgs from '@/messages/plugins.messages'
import * as SETTINGS_Msgs from '@/messages/settings.messages'
import * as CMD from '@/models/command.models'
import * as PLG from '@/models/plugins.models'
import * as RPC from '@/orpc.client'
import { tr } from '@/systems/messages.client'
import * as PluginsClient from '@/systems/plugins.client'
import * as SettingsClient from '@/systems/settings.client'

// The plugins area of the settings page. Enable/disable applies immediately (it starts/stops the plugin).
// Each plugin's config and command overrides are a settings-editor section, saved with the rest of the page.
//
// Installing writes into SLM's plugins folder and runs that copy, so a plugin keeps working when its
// source url does not. Refresh is the only thing that fetches again.

const HOST_API_VERSION = PLG.formatApiVersion()

// same lazy-load dance as the settings page: the CodeMirror bundle is only paid for once an editor is
// actually shown, and the `as` casts restore the generic signature React.lazy erases
const SchemaYamlEditor = React.lazy(
	() => import('@/components/schema-yaml-editor') as unknown as Promise<{ default: React.FC<any> }>,
) as unknown as typeof SchemaYamlEditorComponent

const STATUS_VARIANT = {
	inactive: 'outline',
	activating: 'secondary',
	active: 'info',
	stopping: 'secondary',
	errored: 'destructive',
} as const

export function PluginsSection(props: { canManage: boolean; sectionKeys: SettingsEditorFrame.Key[] }) {
	const plugins = Zus.useStore(PluginsClient.Store, (s) => s.plugins)
	const keyFor = (pluginId: string) => props.sectionKeys.find((k) => k.kind === 'plugin' && k.pluginId === pluginId)
	return (
		<Card>
			<CardHeader>
				<CardTitle>{tr.text(PLUGINS_Msgs.sectionTitle())}</CardTitle>
				<CardDescription>{tr.text(PLUGINS_Msgs.sectionBlurb())}</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				{plugins.length === 0 && <p className="text-sm text-muted-foreground">{tr.text(PLUGINS_Msgs.noPlugins())}</p>}
				{plugins.map((info) => (
					<PluginRow key={info.id} info={info} canManage={props.canManage} settingsKey={keyFor(info.id)} />
				))}
				{props.canManage && <InstallPanel />}
				{props.canManage && <LeftoverDataPanel />}
			</CardContent>
		</Card>
	)
}

// An uninstalled plugin's row and tables outlive it deliberately, so reinstalling restores its settings and
// data. This is the only thing that reclaims them.
function LeftoverDataPanel() {
	const leftoverData = Zus.useStore(PluginsClient.Store, (s) => s.leftoverData)
	if (leftoverData.length === 0) return null
	return (
		<div id="section:plugin-leftover-data" className="scroll-mt-2 rounded-md border p-4 space-y-2">
			<div className="space-y-0.5">
				<p className="text-sm font-medium">{tr.text(PLUGINS_Msgs.leftoverTitle())}</p>
				<p className="text-xs text-muted-foreground">{tr.text(PLUGINS_Msgs.leftoverBlurb())}</p>
			</div>
			{leftoverData.map((entry) => (
				<LeftoverRow key={entry.pluginId} entry={entry} />
			))}
		</div>
	)
}

function LeftoverRow({ entry }: { entry: PLG.LeftoverData }) {
	const [busy, setBusy] = React.useState(false)
	const rows = entry.tables.reduce((sum, t) => sum + t.rows, 0)

	async function purge() {
		if (!window.confirm(tr.text(PLUGINS_Msgs.deleteDataConfirm(entry.pluginId, entry.tables.length)))) return
		setBusy(true)
		try {
			const res = await RPC.orpc.plugins.purgeData.call({ pluginId: entry.pluginId })
			if (res.code === 'ok') toast.success(tr.text(PLUGINS_Msgs.dataDeleted(entry.pluginId)))
			else toast.error(tr.text(PLUGINS_Msgs.actionFailed()))
		} catch {
			toast.error(tr.text(PLUGINS_Msgs.actionFailed()))
		} finally {
			setBusy(false)
		}
	}

	return (
		<div className="flex items-center justify-between gap-3">
			<div className="min-w-0">
				<p className="text-sm font-mono">{entry.pluginId}</p>
				<p className="text-xs text-muted-foreground">{tr.text(PLUGINS_Msgs.leftoverSummary(entry.tables.length, rows))}</p>
			</div>
			<Button size="sm" variant="destructive" disabled={busy} onClick={() => void purge()}>
				{tr.text(PLUGINS_Msgs.deleteData())}
			</Button>
		</div>
	)
}

function InstallPanel() {
	const urlRef = React.useRef<HTMLInputElement>(null)
	const [busy, setBusy] = React.useState(false)

	async function run(action: () => Promise<{ code: string; message?: string }>, ok: string) {
		setBusy(true)
		try {
			const res = await action()
			if (res.code === 'ok') toast.success(ok)
			else toast.error(tr.text(PLUGINS_Msgs.installFailed()), { description: res.message })
		} catch {
			toast.error(tr.text(PLUGINS_Msgs.actionFailed()))
		} finally {
			setBusy(false)
		}
	}

	async function install() {
		const url = urlRef.current?.value?.trim()
		if (!url) return
		await run(() => RPC.orpc.plugins.installFromUrl.call({ url }), tr.text(PLUGINS_Msgs.installed(url)))
		if (urlRef.current) urlRef.current.value = ''
	}

	return (
		<div className="rounded-md border border-dashed p-4 space-y-2">
			<div className="space-y-0.5">
				<p className="text-sm font-medium">{tr.text(PLUGINS_Msgs.installTitle())}</p>
				<p className="text-xs text-muted-foreground">{tr.text(PLUGINS_Msgs.installBlurb())}</p>
			</div>
			<div className="flex items-center gap-2">
				<Input
					ref={urlRef}
					type="url"
					disabled={busy}
					placeholder={tr.text(PLUGINS_Msgs.installPlaceholder())}
					className="h-8 text-xs"
				/>
				<Button size="sm" disabled={busy} onClick={() => void install()}>
					{tr.text(PLUGINS_Msgs.install())}
				</Button>
				<Button
					size="sm"
					variant="outline"
					disabled={busy}
					onClick={() => void run(() => RPC.orpc.plugins.rescan.call(), tr.text(PLUGINS_Msgs.rescanned()))}
				>
					{tr.text(PLUGINS_Msgs.rescan())}
				</Button>
			</div>
		</div>
	)
}

// The triggers this plugin declared that something else already owns, so its commands never dispatch. Resolved
// the same way dispatch resolves them, since a plugin that looks installed and silently does nothing is the
// failure this is here to prevent.
function useCommandConflicts(info: PLG.RuntimeInfo): CMD.CommandConflict[] {
	const settings = Zus.useStore(SettingsClient.PublicSettingsStore)
	const plugins = Zus.useStore(PluginsClient.Store, (s) => s.plugins)
	return React.useMemo(() => {
		if (!settings) return []
		const declared = plugins.flatMap((p) =>
			p.commands.map((decl) => {
				const id = CMD.pluginCommandId(p.id, decl.name)
				const stored = p.commandConfigs[decl.name]
				return { id, config: CMD.pluginCommandConfig(decl, stored, settings.defaultPrefix), configured: stored !== undefined }
			}),
		)
		const { conflicts } = CMD.resolvePluginCommandTriggers(settings.commands, declared)
		const mine = CMD.pluginCommandId(info.id, '')
		return conflicts.filter((c) => c.commandId.startsWith(mine))
	}, [settings, plugins, info.id])
}

function PluginRow({
	info,
	canManage,
	settingsKey,
}: {
	info: PLG.RuntimeInfo
	canManage: boolean
	settingsKey: SettingsEditorFrame.Key | undefined
}) {
	const [toggling, setToggling] = React.useState(false)
	const manifest = Zus.useStore(PluginsClient.Store, (s) => s.manifests[info.id])

	async function act(action: () => Promise<{ code: string; message?: string }>, ok?: string) {
		setToggling(true)
		try {
			const res = await action()
			if (res.code !== 'ok') toast.error(tr.text(PLUGINS_Msgs.actionFailed()), { description: res.message })
			else if (ok) toast.success(ok)
		} catch {
			toast.error(tr.text(PLUGINS_Msgs.actionFailed()))
		} finally {
			setToggling(false)
		}
	}

	async function setEnabled(enabled: boolean) {
		await act(() => RPC.orpc.plugins.setEnabled.call({ pluginId: info.id, enabled }))
	}

	const conflicts = useCommandConflicts(info)

	return (
		<div id={`section:plugin:${info.id}`} className="scroll-mt-2 rounded-md border p-4 space-y-3">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0 space-y-0.5">
					<div className="flex items-center gap-2">
						<p className="text-sm font-medium">{info.name}</p>
						<span className="text-xs text-muted-foreground font-mono">v{info.version}</span>
						<Tooltip>
							<TooltipTrigger asChild>
								<span
									className={cn(
										'text-xs font-mono',
										PLG.satisfiesApiVersion(info.apiVersion) ? 'text-muted-foreground' : 'text-destructive',
									)}
								>
									{tr.text(PLUGINS_Msgs.apiVersionLabel(info.apiVersion))}
								</span>
							</TooltipTrigger>
							<TooltipContent>{tr.text(PLUGINS_Msgs.apiVersionProvided(HOST_API_VERSION))}</TooltipContent>
						</Tooltip>
						<Badge variant={STATUS_VARIANT[info.status]}>{tr.text(PLUGINS_Msgs.statusLabels[info.status]())}</Badge>
					</div>
					<p className="text-xs text-muted-foreground">{info.description}</p>
					{info.error && <p className="text-xs text-destructive whitespace-pre-wrap">{info.error}</p>}
					{conflicts.map((conflict) => (
						<p key={`${conflict.commandId} ${conflict.trigger}`} className="text-xs text-warn">
							{tr.text(PLUGINS_Msgs.commandTriggerTaken(conflict.trigger, conflict.ownedBy))}
						</p>
					))}
				</div>
				<Label className="flex items-center gap-2 shrink-0">
					<Switch
						checked={info.enabled}
						disabled={!canManage || toggling}
						onCheckedChange={(checked) => void setEnabled(checked)}
						aria-label={tr.text(PLUGINS_Msgs.enableLabel(info.name))}
					/>
				</Label>
			</div>
			{canManage && info.source !== 'builtin' && (
				<div className="flex items-center gap-2">
					{info.source === 'url' && (
						<Button
							size="sm"
							variant="outline"
							disabled={toggling}
							onClick={() =>
								void act(() => RPC.orpc.plugins.refresh.call({ pluginId: info.id }), tr.text(PLUGINS_Msgs.refreshed(info.name)))
							}
						>
							{tr.text(PLUGINS_Msgs.refresh())}
						</Button>
					)}
					<Button
						size="sm"
						variant="outline"
						disabled={toggling}
						onClick={() => {
							if (!window.confirm(tr.text(PLUGINS_Msgs.uninstallConfirm(info.name)))) return
							void act(() => RPC.orpc.plugins.uninstall.call({ pluginId: info.id }), tr.text(PLUGINS_Msgs.uninstalled()))
						}}
					>
						{tr.text(PLUGINS_Msgs.uninstall())}
					</Button>
				</div>
			)}
			{canManage && manifest && settingsKey && (
				<PluginSettingsEditor stores={{ settingsEditor: settingsKey }} info={info} manifest={manifest} />
			)}
		</div>
	)
}

// The plugin's config and command overrides, as one settings-editor section. The GUI edits go through the settings
// page's shared save panel; YAML mode edits both as one document and saves from its own toolbar, like every section.
function PluginSettingsEditor({
	stores,
	info,
	manifest,
}: {
	stores: SettingsEditorFrame.KeyProp
	info: PLG.RuntimeInfo
	manifest: PLG.Manifest
}) {
	const key = stores.settingsEditor
	const state = Zus.useStore(key, (s: SettingsEditorFrame.SettingsEditor) => s)
	const { mode, draft, saved, issues, changes, valid, saving } = state
	const editorRef = React.useRef<SchemaYamlEditorHandle>(null)
	const openDialog = useAlertDialog()
	const [configValue$] = React.useState(() => SettingsEditorFrame.draftValueState(key, 'config'))

	if (saved === undefined || draft === undefined) return null
	const current = draft as SettingsEditorFrame.PluginDraft

	// the form renders the config on its own, so it is handed the issues that fall inside it, relative to it
	const configIssues = issues.filter((i) => i.path[0] === 'config').map((i) => ({ ...i, path: i.path.slice(1) }))

	async function handleYamlSave() {
		if (!valid) return
		const msg = tr.confirm(SETTINGS_Msgs.confirmSave())
		const result = await openDialog({
			title: msg.title,
			content: <SettingsChangeList changes={changes} />,
			buttons: [{ id: 'save', label: msg.confirmLabel }],
		})
		if (result === 'save') void SettingsEditorFrame.Actions.save(stores)
	}

	return (
		<div className="space-y-2">
			<div role="group" aria-label={tr.text(PLUGINS_Msgs.configEditorModeLabel(manifest.name))} className="flex items-center gap-1">
				<Button
					size="sm"
					variant={mode === 'gui' ? 'secondary' : 'ghost'}
					onClick={() => SettingsEditorFrame.Actions.setMode(stores, 'gui')}
				>
					GUI
				</Button>
				<Button
					size="sm"
					variant={mode === 'yaml' ? 'secondary' : 'ghost'}
					onClick={() => SettingsEditorFrame.Actions.setMode(stores, 'yaml')}
				>
					YAML
				</Button>
			</div>
			{mode === 'gui' ? (
				<>
					<SettingsForm
						schema={manifest.configSchema}
						value$={configValue$}
						reset$={state.reset$}
						onChange={(config: Record<string, unknown>) => SettingsEditorFrame.Actions.setDraft(stores, { ...current, config })}
						saved={(saved as SettingsEditorFrame.PluginDraft).config}
						idPrefix={`setting:plugin:${info.id}:`}
						issues={configIssues.length > 0 ? configIssues : undefined}
					/>
					<PluginCommandsEditor
						info={info}
						commands={current.commands}
						issues={issues}
						onChange={(commands) => SettingsEditorFrame.Actions.setDraft(stores, { ...current, commands })}
					/>
				</>
			) : (
				<React.Suspense fallback={<p className="text-sm text-muted-foreground">{tr.text(SETTINGS_Msgs.loadingEditor())}</p>}>
					<SchemaYamlEditor
						ref={editorRef}
						schema={SettingsEditorFrame.pluginSchema(info.id, manifest)}
						value={draft}
						onValidChange={(v: any) => SettingsEditorFrame.Actions.setYamlValid(stores, v)}
						minHeightPx={250}
						label={manifest.name}
						toolbar={
							<YamlEditorToolbar
								editorRef={editorRef}
								deniedPaths={NO_PATHS}
								canSave={changes.length > 0 && valid}
								saving={saving}
								onSave={handleYamlSave}
							/>
						}
					/>
				</React.Suspense>
			)}
		</div>
	)
}

const NO_PATHS: never[] = []

type PluginCommandEntry = { id: string; decl: CMD.PluginCommandInfo; config: CMD.CommandConfig; configured: boolean }

// The plugin's in-game commands, each at the config it runs under. Only a running plugin's commands are known, so a
// stopped plugin shows none.
function PluginCommandsEditor({
	info,
	commands,
	issues,
	onChange,
}: {
	info: PLG.RuntimeInfo
	commands: CMD.PluginCommandConfigs
	issues: readonly z.core.$ZodIssue[]
	onChange: (next: CMD.PluginCommandConfigs) => void
}) {
	const settings = Zus.useStore(SettingsClient.PublicSettingsStore)
	const plugins = Zus.useStore(PluginsClient.Store, (s) => s.plugins)

	// an override whose command the running plugin no longer declares: ignored at runtime, but only an admin can
	// decide it is safe to drop. Unknowable while the plugin is stopped.
	const orphans = info.status === 'active' ? Object.keys(commands).filter((name) => !info.commands.some((d) => d.name === name)) : []
	if (!settings || (info.commands.length === 0 && orphans.length === 0)) return null

	const entries = info.commands.map((decl): PluginCommandEntry => ({
		id: CMD.pluginCommandId(info.id, decl.name),
		decl,
		config: CMD.pluginCommandConfig(decl, commands[decl.name], settings.defaultPrefix),
		configured: commands[decl.name] !== undefined,
	}))
	const otherListings = plugins
		.filter((p) => p.id !== info.id)
		.flatMap((p) =>
			p.commands.map((decl): PluginCommandEntry => ({
				id: CMD.pluginCommandId(p.id, decl.name),
				decl,
				config: CMD.pluginCommandConfig(decl, p.commandConfigs[decl.name], settings.defaultPrefix),
				configured: p.commandConfigs[decl.name] !== undefined,
			})),
		)
	const { conflicts } = CMD.resolvePluginCommandTriggers(settings.commands, [...otherListings, ...entries])

	// an unconfigured command materializes at its effective config, so editing one field does not silently pin the
	// others at whatever the schema default happens to be
	function patch(entry: PluginCommandEntry, next: Partial<CMD.PluginCommandConfig>) {
		onChange({ ...commands, [entry.decl.name]: { ...(commands[entry.decl.name] ?? entry.config), ...next } })
	}
	function clear(name: string) {
		const { [name]: _dropped, ...rest } = commands
		onChange(rest)
	}

	return (
		<section aria-label={tr.text(PLUGINS_Msgs.commandsTitle())} className="space-y-2">
			<h3 className="text-sm font-medium">{tr.text(PLUGINS_Msgs.commandsTitle())}</h3>
			{entries.map((entry) => (
				<PluginCommandCard
					key={entry.id}
					idPrefix={`setting:plugin:${info.id}:commands.${entry.decl.name}`}
					entry={entry}
					conflicts={conflicts.filter((c) => c.commandId === entry.id)}
					issues={issues.filter((i) => i.path[0] === 'commands' && i.path[1] === entry.decl.name)}
					onPatch={(next) => patch(entry, next)}
					onReset={() => clear(entry.decl.name)}
				/>
			))}
			{orphans.length > 0 && (
				<div className="space-y-1 rounded-md border border-dashed p-2">
					<p className="text-xs text-muted-foreground">{tr.text(CMD_Msgs.pluginCommandOrphans())}</p>
					{orphans.map((name) => (
						<div key={name} className="flex items-center gap-2">
							<code className="text-xs">{name}</code>
							<Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => clear(name)}>
								{tr.text(CMD_Msgs.pluginCommandDropOverride())}
							</Button>
						</div>
					))}
				</div>
			)}
		</section>
	)
}

function PluginCommandCard({
	idPrefix,
	entry,
	conflicts,
	issues,
	onPatch,
	onReset,
}: {
	idPrefix: string
	entry: PluginCommandEntry
	conflicts: CMD.CommandConflict[]
	// issues under this command, with paths from the section root: ['commands', name, 'triggers', index]
	issues: readonly z.core.$ZodIssue[]
	onPatch: (next: Partial<CMD.PluginCommandConfig>) => void
	onReset: () => void
}) {
	const triggers = entry.config.triggers.map(CMD.triggerString)
	// Only for a declared default. A configured trigger that collides is an issue, which refuses the save outright,
	// and saying both would be noise.
	const takenBy = (trigger: string) =>
		entry.configured ? undefined : conflicts.find((c) => c.trigger.toLowerCase() === trigger.toLowerCase())?.ownedBy
	const setTriggers = (next: string[]) => onPatch({ triggers: next })
	return (
		<div className="space-y-2 rounded-md border p-2">
			<div className="flex flex-wrap items-baseline gap-2">
				<span className="text-sm font-medium">{entry.decl.name}</span>
				<div className="flex-1" />
				{entry.configured && (
					<Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onReset}>
						{tr.text(CMD_Msgs.pluginCommandUseDeclared())}
					</Button>
				)}
			</div>
			<p className="text-xs text-muted-foreground">{entry.decl.description}</p>
			<div className="space-y-1">
				<span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
					{tr.text(CMD_Msgs.triggers())} <HelpTip text={tr.text(CMD_Msgs.triggersHelp())} />
				</span>
				{triggers.map((trigger, idx) => {
					const owner = takenBy(trigger)
					const triggerIssues = issues.filter((i) => i.path[2] === 'triggers' && i.path[3] === idx)
					return (
						<div
							// oxlint-disable-next-line no-array-index-key
							key={idx}
							id={`${idPrefix}.triggers.${idx}`}
							data-settings-error={triggerIssues.length > 0 ? '' : undefined}
							className="space-y-0.5"
						>
							<div className="flex items-center gap-1">
								<Input
									className="h-7 w-40 text-xs"
									defaultValue={trigger}
									key={`${entry.configured}:${trigger}`}
									placeholder={tr.text(CMD_Msgs.triggerStringPlaceholder())}
									onBlur={(e) => setTriggers(triggers.map((t, i) => (i === idx ? e.target.value.trim() : t)))}
								/>
								{triggers.length > 1 && (
									<Button
										type="button"
										variant="ghost"
										size="sm"
										className="h-6 px-2 text-xs"
										onClick={() => setTriggers(triggers.filter((_, i) => i !== idx))}
									>
										<Icons.X className="h-3 w-3" />
									</Button>
								)}
							</div>
							{owner && <p className="text-xs text-warn">{tr.text(CMD_Msgs.pluginTriggerTakenBy(owner))}</p>}
							{triggerIssues.map((issue) => (
								<p key={issue.message} className="text-xs text-destructive">
									{issue.message}
								</p>
							))}
						</div>
					)
				})}
				<Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setTriggers([...triggers, ''])}>
					{tr.text(SETTINGS_Msgs.addEntry())}
				</Button>
			</div>
			<div className="flex flex-wrap items-center gap-4">
				<div className="flex items-center gap-2">
					<span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
						{tr.text(CMD_Msgs.allowedChats())} <HelpTip text={tr.text(CMD_Msgs.allowedChatsHelp())} />
					</span>
					<ComboBoxMulti
						title={tr.text(CMD_Msgs.allowedChats())}
						values={entry.config.allowedChats}
						options={CMD.CHAT_GROUPS.options.map((group) => ({ value: group, label: tr.text(CMD_Msgs.chatGroupLabels[group]) }))}
						onSelect={(next) => onPatch({ allowedChats: typeof next === 'function' ? next(entry.config.allowedChats) : next })}
					/>
				</div>
				<label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
					<Switch checked={entry.config.enabled} onCheckedChange={(v) => onPatch({ enabled: v })} />
					{tr.text(CMD_Msgs.enabled())}
				</label>
				<label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
					<Checkbox checked={entry.config.quickReference} onCheckedChange={(v) => onPatch({ quickReference: v === true })} />
					<span className="flex items-center gap-1">
						{tr.text(CMD_Msgs.quickReference())}
						<HelpTip text={tr.text(CMD_Msgs.quickReferenceHelp())} />
					</span>
				</label>
			</div>
		</div>
	)
}
