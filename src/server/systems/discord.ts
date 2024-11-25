import { z } from 'zod'

export const DiscordUserSchema = z.object({
	id: z.string().transform(BigInt),
	username: z.string(),
	global_name: z.string(),
	discriminator: z.string(),
	avatar: z.string(),
	locale: z.string(),
	flags: z.number(),
	premium_type: z.number(),
	public_flags: z.number(),
})

export type AccessToken = {
	access_token: string
	token_type: string
}

export async function getUser(token: AccessToken) {
	const fetchDiscordUserRes = await fetch('https://discord.com/api/users/@me', {
		headers: { Authorization: `${token.token_type} ${token.access_token}` },
	})
	if (!fetchDiscordUserRes.ok) {
		return Promise.resolve(null)
	}

	const data = await fetchDiscordUserRes.json()
	return DiscordUserSchema.parse(data)
}
