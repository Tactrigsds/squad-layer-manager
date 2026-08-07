// The handful of pages the control plane serves itself. It is not the app and cannot render the app's landing
// page, which lives in the client bundle behind an instance.
//
// TODO: the wording here is placeholder. Every string a visitor reads ships forever; see the app-text rule in
// CLAUDE.md. Nothing below has been through a copy pass.

const STYLE = `
	:root { color-scheme: light dark; }
	body {
		margin: 0; min-height: 100vh; display: grid; place-items: center;
		font-family: system-ui, sans-serif; line-height: 1.5;
		background: Canvas; color: CanvasText;
	}
	main { max-width: 34rem; padding: 2rem 1.25rem; }
	h1 { font-size: 1.6rem; margin: 0 0 0.75rem; }
	p { margin: 0 0 1rem; }
	.actions { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 1.5rem; }
	a.button, button {
		font: inherit; padding: 0.6rem 1.1rem; border-radius: 6px; border: 1px solid currentColor;
		background: none; color: inherit; text-decoration: none; cursor: pointer;
	}
	a.button.primary, button.primary { background: CanvasText; color: Canvas; border-color: CanvasText; }
	small { opacity: 0.7; }
`

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function page(title: string, body: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`
}

export function landing(opts: { installUrl: string | null; existingInstanceUrl: string | null }): string {
	const tryButton = opts.existingInstanceUrl
		? `<a class="button primary" href="${escapeHtml(opts.existingInstanceUrl)}">Back to your demo</a>`
		: `<form method="post" action="/try"><button class="primary" type="submit">Try it now</button></form>`
	const install = opts.installUrl ? `<a class="button" href="${escapeHtml(opts.installUrl)}">Add to your Discord server</a>` : ''
	return page(
		'Squad Layer Manager demo',
		`<h1>Squad Layer Manager</h1>
		<p>A demo instance with an emulated squad server behind it. The queue, the filters, the votes and the
		in-game commands all work; nobody real is playing.</p>
		<div class="actions">${tryButton}${install}</div>
		<p><small>A demo you start here is anonymous and short-lived. Adding the app to a Discord server gets a
		longer-lived instance that signs your members in.</small></p>`,
	)
}

export function atCapacity(kind: 'guild' | 'ephemeral'): string {
	const detail = kind === 'guild' ? 'The fleet is at its guild limit right now.' : 'Every anonymous demo slot is in use right now.'
	return page(
		'The demo is full',
		`<h1>The demo is full</h1><p>${detail} Try again in a little while.</p>
		<div class="actions"><a class="button" href="/">Back</a></div>`,
	)
}

export function rateLimited(): string {
	return page(
		'Too many demos',
		`<h1>Too many demos</h1><p>You have started several demos recently. Use the one you already have, or wait
		an hour.</p><div class="actions"><a class="button" href="/">Back</a></div>`,
	)
}

export function starting(url: string): string {
	return page(
		'Starting your demo',
		`<h1>Starting your demo</h1><p>This takes a few seconds.</p>
		<script>setTimeout(function(){ location.href = ${JSON.stringify(url)} }, 2000)</script>
		<div class="actions"><a class="button primary" href="${escapeHtml(url)}">Go now</a></div>`,
	)
}

export function notFound(): string {
	return page(
		'Not found',
		`<h1>Not found</h1><p>There is no demo at this address. It may have been reaped.</p>
		<div class="actions"><a class="button" href="/">Start a new one</a></div>`,
	)
}

// a start that failed but has not hit the crash limit: distinct from broken(), whose "no longer retried" would
// be wrong here
export function startFailed(): string {
	return page(
		'This demo did not start',
		`<h1>This demo did not start</h1><p>Something went wrong bringing it up. Reload to try again.</p>
		<div class="actions"><a class="button" href="/">Back to the portal</a></div>`,
	)
}

export function broken(): string {
	return page(
		'This demo stopped',
		`<h1>This demo stopped</h1><p>It failed to start several times and is no longer being retried.</p>
		<div class="actions"><a class="button" href="/">Start a new one</a></div>`,
	)
}

export function error(message: string): string {
	return page(
		'Something went wrong',
		`<h1>Something went wrong</h1><p>${escapeHtml(message)}</p>
		<div class="actions"><a class="button" href="/">Back</a></div>`,
	)
}

export function fleetStatus(rows: { host: string; kind: string; state: string; idleFor: string; age: string }[]): string {
	const body = rows
		.map(
			(r) =>
				`<tr><td>${escapeHtml(r.host)}</td><td>${escapeHtml(r.kind)}</td><td>${escapeHtml(r.state)}</td>` +
				`<td>${escapeHtml(r.idleFor)}</td><td>${escapeHtml(r.age)}</td></tr>`,
		)
		.join('')
	return page(
		'Fleet status',
		`<h1>Fleet status</h1><p>${rows.length} instance${rows.length === 1 ? '' : 's'}.</p>
		<table><thead><tr><th>host</th><th>kind</th><th>state</th><th>idle</th><th>age</th></tr></thead>
		<tbody>${body}</tbody></table>`,
	)
}
