import * as AR from '@/app-routes.ts'
import * as Env from '@/server/env.ts'
import { initModule } from '@/server/logger'

// Static, no-JS pages served outside the SPA: the login landing at '/' and the 403 shown to authenticated
// users who lack site access. Rendered once at setup() and held as strings, so requests never re-render them.

const DEFAULT_REPO_URL = 'https://github.com/Tactrigsds/squad-layer-manager'

const envBuilder = Env.getEnvBuilder({ ...Env.groups.general })
let ENV!: ReturnType<typeof envBuilder>
const module = initModule('landing')

let landingHtmlCache!: string
let forbiddenHtmlCache!: string

export function setup() {
	ENV = envBuilder()
	const repoUrl = ENV.PUBLIC_REPO_URL ?? DEFAULT_REPO_URL
	landingHtmlCache = renderLanding(repoUrl)
	forbiddenHtmlCache = renderForbidden(repoUrl)
	module.getLogger().info('landing pages rendered')
}

export function landingHtml() {
	return landingHtmlCache
}

export function forbiddenHtml() {
	return forbiddenHtmlCache
}

const DISCORD_ICON =
	`<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M20.317 4.369a19.79 19.79 0 0 0-4.885-1.515a.074.074 0 0 0-.078.037c-.211.375-.444.865-.608 1.25a18.27 18.27 0 0 0-5.487 0a12.6 12.6 0 0 0-.617-1.25a.077.077 0 0 0-.079-.037A19.74 19.74 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057a19.9 19.9 0 0 0 5.993 3.03a.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106a13.1 13.1 0 0 1-1.872-.892a.077.077 0 0 1-.008-.128a10.2 10.2 0 0 0 .372-.292a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.009c.12.098.246.198.373.292a.077.077 0 0 1-.006.127a12.3 12.3 0 0 1-1.873.893a.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028a19.84 19.84 0 0 0 6.002-3.03a.077.077 0 0 0 .032-.056c.5-5.177-.838-9.674-3.549-13.66a.06.06 0 0 0-.031-.028zM8.02 15.331c-1.183 0-2.157-1.085-2.157-2.419c0-1.333.955-2.419 2.157-2.419c1.211 0 2.176 1.096 2.157 2.42c0 1.333-.955 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419c0-1.333.955-2.419 2.157-2.419c1.211 0 2.176 1.096 2.157 2.42c0 1.333-.946 2.418-2.157 2.418z"/></svg>`

const GITHUB_ICON =
	`<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 .297c-6.63 0-12 5.373-12 12c0 5.303 3.438 9.8 8.205 11.385c.6.113.82-.258.82-.577c0-.285-.01-1.04-.015-2.04c-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729c1.205.084 1.838 1.236 1.838 1.236c1.07 1.835 2.809 1.305 3.495.998c.108-.776.417-1.305.76-1.605c-2.665-.3-5.466-1.332-5.466-5.93c0-1.31.465-2.38 1.235-3.22c-.135-.303-.54-1.523.105-3.176c0 0 1.005-.322 3.3 1.23c.957-.266 1.983-.399 3.003-.404c1.02.005 2.047.138 3.006.404c2.291-1.552 3.297-1.23 3.297-1.23c.653 1.653.242 2.873.118 3.176c.77.84 1.233 1.91 1.233 3.22c0 4.61-2.807 5.625-5.479 5.92c.43.372.823 1.102.823 2.222c0 1.606-.014 2.898-.014 3.293c0 .322.216.694.825.576C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>`

function shell(title: string, body: string) {
	return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
--bg:hsl(240 10% 3.9%);--fg:hsl(0 0% 98%);--muted:hsl(240 5% 64.9%);
--panel:hsl(240 6% 8%);--border:hsl(240 3.7% 15.9%);--blurple:#5865f2;--blurple-hover:#4752c4;
--destructive:hsl(0 72% 51%);
}
html,body{height:100%}
body{background:var(--bg);color:var(--fg);font-family:"Roboto Condensed",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
display:flex;align-items:center;justify-content:center;min-height:100vh;padding:1.5rem;line-height:1.5;-webkit-font-smoothing:antialiased}
main{width:100%;max-width:30rem;background:var(--panel);border:1px solid var(--border);border-radius:0.75rem;
padding:2.5rem 2rem;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,0.4)}
h1{font-size:1.75rem;font-weight:700;letter-spacing:-0.01em;margin-bottom:0.5rem}
.sub{color:var(--muted);font-size:1rem;margin-bottom:1.75rem}
.note{color:var(--muted);font-size:0.875rem;margin-top:1.5rem;padding-top:1.5rem;border-top:1px solid var(--border)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:0.6rem;width:100%;
padding:0.75rem 1.25rem;border-radius:0.5rem;font-size:1rem;font-weight:600;font-family:inherit;
text-decoration:none;cursor:pointer;border:1px solid transparent;transition:background-color 0.15s ease}
.btn-discord{background:var(--blurple);color:#fff}
.btn-discord:hover{background:var(--blurple-hover)}
.btn-secondary{background:transparent;color:var(--fg);border-color:var(--border)}
.btn-secondary:hover{background:var(--border)}
form{margin:0}
.actions{display:flex;flex-direction:column;gap:0.75rem}
.repo{display:inline-flex;align-items:center;gap:0.4rem;color:var(--muted);text-decoration:none;font-size:0.875rem}
.repo:hover{color:var(--fg)}
.badge{width:3.5rem;height:3.5rem;border-radius:9999px;display:inline-flex;align-items:center;justify-content:center;
margin-bottom:1.25rem;background:hsl(240 3.7% 15.9%)}
.badge svg{width:1.75rem;height:1.75rem}
.badge-deny{background:hsl(0 62.8% 30.6% / 0.25);color:hsl(0 84% 70%)}
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`
}

function repoLink(repoUrl: string) {
	return `<a class="repo" href="${repoUrl}" target="_blank" rel="noopener noreferrer">${GITHUB_ICON}<span>View on GitHub</span></a>`
}

function renderLanding(repoUrl: string) {
	const body = `
<h1>Squad Layer Manager</h1>
<p class="sub">Sign in to manage layer queues, generation, and your Squad servers.</p>
<div class="actions">
<a class="btn btn-discord" href="${AR.route('/login')}">${DISCORD_ICON}<span>Log in with Discord</span></a>
</div>
<p class="note">You need admin permissions in the configured Discord to access SLM. If you have just been granted access, log in again.</p>
<p class="note" style="border-top:none;padding-top:0.75rem;margin-top:0.75rem">${repoLink(repoUrl)}</p>`
	return shell('Squad Layer Manager', body)
}

function renderForbidden(repoUrl: string) {
	const body = `
<div class="badge badge-deny">${DISCORD_ICON}</div>
<h1>Access denied</h1>
<p class="sub">Your Discord account is not authorized to use SLM.</p>
<div class="actions">
<a class="btn btn-secondary" href="${AR.route('/')}">Back to home</a>
<form action="${AR.route('/logout')}" method="POST">
<button class="btn btn-secondary" type="submit">Log out and switch account</button>
</form>
</div>
<p class="note">You need admin permissions in the configured Discord to access SLM. If you believe this is a mistake, contact an administrator.</p>
<p class="note" style="border-top:none;padding-top:0.75rem;margin-top:0.75rem">${repoLink(repoUrl)}</p>`
	return shell('Access denied - Squad Layer Manager', body)
}
