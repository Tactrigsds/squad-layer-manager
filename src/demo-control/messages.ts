// Every message the fleet sends into a discord server, in one file so the wording can be read as a set.
//
// All three go to the server's owner, which is who the bot can always reach without asking for a permission. The
// owner is not necessarily who added the app: the installer is sent to the instance directly (see
// broker.completeInstall), and this is what reaches everybody else.
//
// TODO: placeholder copy, not signed off. These go out under the project's name to people who just installed it,
// and they ship forever; see the app-text rule in CLAUDE.md.

export function welcome(instanceUrl: string): string {
	return [
		'Squad Layer Manager has been added to this server.',
		'',
		`Its demo instance is at ${instanceUrl}`,
		'',
		'Anyone in this server can sign in with Discord. The first person with Manage Server to log in picks which',
		'role gets full access; everyone else starts with read access.',
		'',
		'There is no real squad server behind it. SLM emulates one, so the queue, the votes and the in-game commands',
		'all work against players who do not exist.',
		'',
		'The instance is deleted after three days with nobody using it, and the bot leaves. Reinstall for a fresh one,',
		'or self-host to keep what you build.',
	].join('\n')
}

export function atCapacity(apexUrl: string): string {
	return [
		'Squad Layer Manager could not start a demo for this server: the demo fleet is full.',
		'',
		`Try installing again later, or start an anonymous demo at ${apexUrl}`,
		'',
		'The bot has left this server. Nothing was configured.',
	].join('\n')
}

export function reapedForIdleness(apexUrl: string, _reason: 'idle'): string {
	return [
		"Squad Layer Manager's demo for this server has been deleted after three days with nobody using it, and the",
		'bot has left.',
		'',
		`Install it again for a fresh demo, or self-host a real instance: ${apexUrl}`,
	].join('\n')
}
