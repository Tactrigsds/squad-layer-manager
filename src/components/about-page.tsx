import { Copy } from 'lucide-react'

import LogoMark from '@/components/logo-mark'
import ManagedServersCard from '@/components/managed-servers-card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/lib/toast'
import { formatVersion } from '@/lib/versioning'
import * as Zus from '@/lib/zustand'
import * as APP_Msgs from '@/messages/app.messages'
import * as ConfigClient from '@/systems/config.client'
import * as SettingsClient from '@/systems/settings.client'
import * as UsersClient from '@/systems/users.client'

function LinkRow({ heading, url }: { heading: string; url: string | undefined }) {
	// a deployment that hasn't named a help or discord url has nowhere to send anyone, so the row is dropped
	if (!url) return null
	return (
		<div className="flex flex-col space-y-1">
			<span className="font-semibold">{heading}</span>
			<a href={url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline break-all">
				{url}
			</a>
		</div>
	)
}

function NameList({ names }: { names: readonly string[] }) {
	return (
		<ul className="flex flex-wrap gap-1.5">
			{names.map((name) => (
				<li key={name}>
					<Badge variant="secondary" className="font-normal">
						{name}
					</Badge>
				</li>
			))}
		</ul>
	)
}

export default function AboutPage() {
	const config = Zus.useStore(ConfigClient.Store)
	const settings = Zus.useStore(SettingsClient.PublicSettingsStore)
	const user = UsersClient.useLoggedInUser()
	if (!config || !user) return null

	const versionText = APP_Msgs.versionInfo({
		appVersion:
			config.PUBLIC_GIT_BRANCH || config.PUBLIC_GIT_SHA ? formatVersion(config.PUBLIC_GIT_BRANCH, config.PUBLIC_GIT_SHA) : undefined,
		layersVersion: config.layersVersion ?? undefined,
		username: user.username,
		wsClientId: config.wsClientId,
	}).text()

	return (
		<div className="w-full max-w-lg mx-auto py-6 space-y-4 overflow-y-auto">
			<div className="flex flex-col items-center gap-3 pb-2">
				<LogoMark accent={settings?.topBarColor ?? null} className="h-14 w-14" />
				<div className="flex flex-col items-center gap-1.5">
					<h1 className="text-sm font-medium uppercase tracking-[0.14em] text-muted-foreground">{APP_Msgs.productName().text()}</h1>
					<p className="text-center text-sm text-muted-foreground">{APP_Msgs.tagline().text()}</p>
				</div>
			</div>

			<ManagedServersCard />

			<Card>
				<CardHeader>
					<CardTitle>{APP_Msgs.debugInfo().text()}</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4 text-sm">
					<LinkRow heading={APP_Msgs.repositoryHeading().text()} url={config.repoUrl} />
					<LinkRow heading={APP_Msgs.helpHeading().text()} url={config.helpUrl} />
					<LinkRow heading={APP_Msgs.discordHelpHeading().text()} url={config.discordHelpUrl} />
					<LinkRow heading={APP_Msgs.reportIssuesHeading().text()} url={config.issuesUrl} />
					<div className="relative">
						<Textarea
							readOnly
							tabIndex={-1}
							className="text-xs font-mono pr-10 resize-none focus-visible:ring-0 focus-visible:ring-offset-0"
							rows={versionText.split('\n').length}
							value={versionText}
						/>
						<Button
							variant="ghost"
							size="icon"
							className="absolute top-1 right-1 h-6 w-6"
							onClick={async () => {
								await navigator.clipboard.writeText(versionText)
								toast(...APP_Msgs.copiedToClipboard(APP_Msgs.versionInfoCopied().text()).toast())
							}}
						>
							<Copy className="h-3 w-3" />
						</Button>
					</div>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>{APP_Msgs.acknowledgementsHeading().text()}</CardTitle>
				</CardHeader>
				<CardContent className="space-y-5 text-sm leading-relaxed text-muted-foreground [&_strong]:font-semibold [&_strong]:text-foreground">
					<p>{APP_Msgs.acknowledgementsIntro().react()}</p>
					<div className="space-y-3 border-l-2 border-border pl-4">
						<p>{APP_Msgs.acknowledgementsZero().react()}</p>
						<p>{APP_Msgs.acknowledgementsRandyNewman().react()}</p>
					</div>
					<div className="space-y-2">
						<p>{APP_Msgs.acknowledgementsContributorsIntro().text()}</p>
						<NameList names={APP_Msgs.acknowledgedContributors} />
					</div>
					<div className="space-y-2">
						<p>{APP_Msgs.acknowledgementsUsersIntro().text()}</p>
						<NameList names={APP_Msgs.acknowledgedUsers} />
					</div>
				</CardContent>
			</Card>
		</div>
	)
}
