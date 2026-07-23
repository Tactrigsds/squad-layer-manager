// The server build (tsx in dev) transpiles this file with the classic JSX runtime, which needs React in scope;
// keep this import even though the client-side automatic runtime would not require it.
import * as React from 'react'

// Presentational components for the static, no-hydration login landing page and the 403 page. Rendered to a
// cached HTML string at boot by landing.server.ts (renderToStaticMarkup); never mounted on the client. Styled
// with the app's Tailwind classes: the compiled stylesheet is linked via `assetLinks` (see landing.server.ts),
// and Tailwind's @source glob picks these classes up because it scans every .tsx regardless of the import graph.

const DISCORD_PATH =
	'M20.317 4.369a19.79 19.79 0 0 0-4.885-1.515a.074.074 0 0 0-.078.037c-.211.375-.444.865-.608 1.25a18.27 18.27 0 0 0-5.487 0a12.6 12.6 0 0 0-.617-1.25a.077.077 0 0 0-.079-.037A19.74 19.74 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057a19.9 19.9 0 0 0 5.993 3.03a.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106a13.1 13.1 0 0 1-1.872-.892a.077.077 0 0 1-.008-.128a10.2 10.2 0 0 0 .372-.292a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.009c.12.098.246.198.373.292a.077.077 0 0 1-.006.127a12.3 12.3 0 0 1-1.873.893a.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028a19.84 19.84 0 0 0 6.002-3.03a.077.077 0 0 0 .032-.056c.5-5.177-.838-9.674-3.549-13.66a.06.06 0 0 0-.031-.028zM8.02 15.331c-1.183 0-2.157-1.085-2.157-2.419c0-1.333.955-2.419 2.157-2.419c1.211 0 2.176 1.096 2.157 2.42c0 1.333-.955 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419c0-1.333.955-2.419 2.157-2.419c1.211 0 2.176 1.096 2.157 2.42c0 1.333-.946 2.418-2.157 2.418z'

const GITHUB_PATH =
	'M12 .297c-6.63 0-12 5.373-12 12c0 5.303 3.438 9.8 8.205 11.385c.6.113.82-.258.82-.577c0-.285-.01-1.04-.015-2.04c-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729c1.205.084 1.838 1.236 1.838 1.236c1.07 1.835 2.809 1.305 3.495.998c.108-.776.417-1.305.76-1.605c-2.665-.3-5.466-1.332-5.466-5.93c0-1.31.465-2.38 1.235-3.22c-.135-.303-.54-1.523.105-3.176c0 0 1.005-.322 3.3 1.23c.957-.266 1.983-.399 3.003-.404c1.02.005 2.047.138 3.006.404c2.291-1.552 3.297-1.23 3.297-1.23c.653 1.653.242 2.873.118 3.176c.77.84 1.233 1.91 1.233 3.22c0 4.61-2.807 5.625-5.479 5.92c.43.372.823 1.102.823 2.222c0 1.606-.014 2.898-.014 3.293c0 .322.216.694.825.576C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12'

function DiscordIcon() {
	return (
		<svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden="true">
			<path d={DISCORD_PATH} />
		</svg>
	)
}

function GithubIcon() {
	return (
		<svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true">
			<path d={GITHUB_PATH} />
		</svg>
	)
}

function RepoLink({ repoUrl }: { repoUrl: string }) {
	return (
		<a
			href={repoUrl}
			target="_blank"
			rel="noopener noreferrer"
			className="mt-4 inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
		>
			<GithubIcon />
			<span>View on GitHub</span>
		</a>
	)
}

const ADMIN_NOTE = 'You need admin permissions in the configured Discord to access SLM.'

function Document(
	{ title, assetLinks, children }: { title: string; assetLinks: readonly AssetLink[]; children: React.ReactNode },
) {
	return (
		<html lang="en" className="dark">
			<head>
				<meta charSet="UTF-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1.0" />
				<title>{title}</title>
				{assetLinks.map((link) => <link key={link.href} {...link} />)}
			</head>
			<body className="min-h-screen">
				<div className="flex min-h-screen items-center justify-center p-6">
					{children}
				</div>
			</body>
		</html>
	)
}

function LandingPage({ repoUrl }: { repoUrl: string }) {
	return (
		<main className="w-full max-w-md rounded-xl border bg-card p-8 text-center shadow-lg">
			<h1 className="text-2xl font-bold tracking-tight">Squad Layer Manager</h1>
			<p className="mt-2 text-muted-foreground">Sign in to manage layer queues, generation, and your Squad servers.</p>
			<a
				href="/login"
				className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-md bg-[#5865f2] px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-[#4752c4]"
			>
				<DiscordIcon />
				<span>Log in with Discord</span>
			</a>
			<p className="mt-6 border-t pt-6 text-sm text-muted-foreground">
				{ADMIN_NOTE} If you have just been granted access, log in again.
			</p>
			<RepoLink repoUrl={repoUrl} />
		</main>
	)
}

function ForbiddenPage({ repoUrl }: { repoUrl: string }) {
	return (
		<main className="w-full max-w-md rounded-xl border bg-card p-8 text-center shadow-lg">
			<div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-destructive/20 text-destructive-foreground">
				<DiscordIcon />
			</div>
			<h1 className="text-2xl font-bold tracking-tight">Access denied</h1>
			<p className="mt-2 text-muted-foreground">Your Discord account is not authorized to use SLM.</p>
			<div className="mt-6 flex flex-col gap-3">
				<a
					href="/"
					className="inline-flex w-full items-center justify-center rounded-md border bg-secondary px-5 py-3 text-sm font-semibold text-secondary-foreground transition-colors hover:bg-secondary/80"
				>
					Back to home
				</a>
				<form action="/logout" method="POST">
					<button
						type="submit"
						className="inline-flex w-full items-center justify-center rounded-md border bg-secondary px-5 py-3 text-sm font-semibold text-secondary-foreground transition-colors hover:bg-secondary/80"
					>
						Log out and switch account
					</button>
				</form>
			</div>
			<p className="mt-6 border-t pt-6 text-sm text-muted-foreground">
				{ADMIN_NOTE} If you believe this is a mistake, contact an administrator.
			</p>
			<RepoLink repoUrl={repoUrl} />
		</main>
	)
}

export function LandingDocument(
	{ variant, repoUrl, assetLinks }: { variant: 'landing' | 'forbidden'; repoUrl: string; assetLinks: readonly AssetLink[] },
) {
	const title = variant === 'landing' ? 'Squad Layer Manager' : 'Access denied - Squad Layer Manager'
	return (
		<Document title={title} assetLinks={assetLinks}>
			{variant === 'landing' ? <LandingPage repoUrl={repoUrl} /> : <ForbiddenPage repoUrl={repoUrl} />}
		</Document>
	)
}

type AssetLink = { rel: string; href: string; crossOrigin?: 'anonymous' | ''; as?: string }
