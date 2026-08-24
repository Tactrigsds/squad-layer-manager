import { useQuery } from '@tanstack/react-query'
import * as Icons from 'lucide-react'
import React from 'react'
import { toast } from 'sonner'
import type { z } from 'zod'

import type SchemaYamlEditorComponent from '@/components/schema-yaml-editor'
import type { SchemaYamlEditorHandle } from '@/components/schema-yaml-editor.types'
import SettingsForm from '@/components/settings-form'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import * as Obj from '@/lib/object-utils'
import * as Rx from '@/lib/rxjs'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as PLUGINS_Msgs from '@/messages/plugins.messages'
import * as SETTINGS_Msgs from '@/messages/settings.messages'
import * as PLG from '@/models/plugins.models'
import * as RPC from '@/orpc.client'
import { tr } from '@/systems/messages.client'
import * as PluginsClient from '@/systems/plugins.client'

// The plugins area of the settings page. Deliberately self-contained: enable/disable applies
// immediately (it starts/stops the plugin), and each plugin's config has its own save/discard,
// outside the settings page's draft machinery.
//
// Installing writes into SLM's plugins folder and runs that copy, so a plugin keeps working when its
// source url does not. Refresh is the only thing that fetches again.

const HOST_API_VERSION = `${PLG.API_VERSION.major}.${PLG.API_VERSION.minor}`

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

export function PluginsSection(props: { canManage: boolean }) {
	const plugins = Zus.useStore(PluginsClient.Store, (s) => s.plugins)
	return (
		<Card>
			<CardHeader>
				<CardTitle>{tr.text(PLUGINS_Msgs.sectionTitle())}</CardTitle>
				<CardDescription>{tr.text(PLUGINS_Msgs.sectionBlurb())}</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				{plugins.length === 0 && <p className="text-sm text-muted-foreground">{tr.text(PLUGINS_Msgs.noPlugins())}</p>}
				{plugins.map((info) => (
					<PluginRow key={info.id} info={info} canManage={props.canManage} />
				))}
				{props.canManage && <InstallPanel />}
			</CardContent>
		</Card>
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

function PluginRow({ info, canManage }: { info: PLG.RuntimeInfo; canManage: boolean }) {
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
			{canManage && manifest && <PluginConfigEditor pluginId={info.id} manifest={manifest} />}
		</div>
	)
}

function PluginConfigEditor({ pluginId, manifest }: { pluginId: string; manifest: PLG.Manifest }) {
	const { data, refetch } = useQuery(RPC.orpc.plugins.getConfig.queryOptions({ input: { pluginId } }))
	if (!data || !('code' in data) || data.code !== 'ok') return null
	return (
		<PluginConfigForm key={JSON.stringify(data.config)} pluginId={pluginId} manifest={manifest} saved={data.config} refetch={refetch} />
	)
}

function PluginConfigForm(props: { pluginId: string; manifest: PLG.Manifest; saved: unknown; refetch: () => unknown }) {
	const [value$] = React.useState(() => new Rx.BehaviorSubject<any>(Obj.deepClone(props.saved)))
	const [reset$] = React.useState(() => new Rx.Subject<void>())
	const [dirty, setDirty] = React.useState(false)
	const [issues, setIssues] = React.useState<readonly z.core.$ZodIssue[] | undefined>()
	const [saving, setSaving] = React.useState(false)
	const mode = Zus.useStore(PluginsClient.ConfigEditorModeStore, (s) => s[props.pluginId] ?? 'gui')
	// the editor re-syncs its contents whenever this changes by value, so it holds the draft as of the last
	// deliberate reseed (entering yaml, discarding) rather than every keystroke
	const [yamlSeed, setYamlSeed] = React.useState<any>(() => Obj.deepClone(props.saved))
	const [yamlValid, setYamlValid] = React.useState(true)
	const editorRef = React.useRef<SchemaYamlEditorHandle>(null)

	function onChange(next: any) {
		value$.next(next)
		setDirty(!Obj.deepEqual(next, props.saved))
		const res = props.manifest.configSchema.safeParse(next)
		setIssues(res.success ? undefined : res.error.issues)
	}

	// null means the contents don't parse or don't validate; anything else already satisfies the schema
	function onYamlChange(next: any) {
		setYamlValid(next !== null)
		if (next === null) return
		value$.next(next)
		setDirty(!Obj.deepEqual(next, props.saved))
		setIssues(undefined)
	}

	function switchMode(next: 'gui' | 'yaml') {
		if (next === 'yaml') {
			setYamlSeed(Obj.deepClone(value$.getValue()))
			setYamlValid(true)
		}
		PluginsClient.setConfigEditorMode(props.pluginId, next)
	}

	async function save() {
		setSaving(true)
		try {
			const res = await RPC.orpc.plugins.updateConfig.call({ pluginId: props.pluginId, config: value$.getValue() })
			if (res.code === 'ok') {
				toast.success(tr.text(PLUGINS_Msgs.configSaved(props.manifest.name)))
				props.refetch()
			} else if (res.code === 'err:invalid-config') {
				toast.error(tr.text(PLUGINS_Msgs.configInvalid()), { description: res.message })
			} else {
				toast.error(tr.text(PLUGINS_Msgs.actionFailed()))
			}
		} catch {
			toast.error(tr.text(PLUGINS_Msgs.actionFailed()))
		} finally {
			setSaving(false)
		}
	}

	function discard() {
		const restored = Obj.deepClone(props.saved)
		value$.next(restored)
		setYamlSeed(restored)
		setYamlValid(true)
		setDirty(false)
		setIssues(undefined)
		reset$.next()
	}

	const canSave = dirty && !issues && yamlValid
	const actions = (
		<>
			<Button size="sm" onClick={() => void save()} disabled={!canSave || saving}>
				{tr.text(PLUGINS_Msgs.saveConfig())}
			</Button>
			<Button size="sm" variant="outline" onClick={discard} disabled={saving || !dirty}>
				{tr.text(PLUGINS_Msgs.discardConfig())}
			</Button>
		</>
	)

	return (
		<div className="space-y-2">
			<div
				role="group"
				aria-label={tr.text(PLUGINS_Msgs.configEditorModeLabel(props.manifest.name))}
				className="flex items-center gap-1"
			>
				<Button size="sm" variant={mode === 'gui' ? 'secondary' : 'ghost'} onClick={() => switchMode('gui')}>
					GUI
				</Button>
				<Button size="sm" variant={mode === 'yaml' ? 'secondary' : 'ghost'} onClick={() => switchMode('yaml')}>
					YAML
				</Button>
			</div>
			{mode === 'gui' ? (
				<>
					<SettingsForm
						schema={props.manifest.configSchema}
						value$={value$}
						reset$={reset$}
						onChange={onChange}
						saved={props.saved}
						idPrefix={`setting:plugin:${props.pluginId}:`}
						issues={issues}
					/>
					{dirty && <div className="flex items-center gap-2">{actions}</div>}
				</>
			) : (
				<React.Suspense fallback={<p className="text-sm text-muted-foreground">{tr.text(SETTINGS_Msgs.loadingEditor())}</p>}>
					<SchemaYamlEditor
						ref={editorRef}
						schema={props.manifest.configSchema}
						value={yamlSeed}
						onValidChange={onYamlChange}
						minHeightPx={250}
						label={props.manifest.name}
						toolbar={
							<>
								<Button size="sm" variant="outline" onClick={() => editorRef.current?.format()}>
									<Icons.Braces className="h-4 w-4" />
									{tr.text(SETTINGS_Msgs.format())}
								</Button>
								{actions}
							</>
						}
					/>
				</React.Suspense>
			)}
		</div>
	)
}
