import { createEnv } from '@t3-oss/env-core'
import dotenv from 'dotenv'
import { z } from 'zod'

dotenv.config()

const StrBool = z
	.string()
	.toLowerCase()
	.pipe(z.union([z.literal('true'), z.literal('false')]))

export const ENV = createEnv({
	server: {
		NODE_ENV: z.enum(['development'], { message: 'TODO configure prod' }),
		DB_HOST: z.string().min(1),
		DB_PORT: z
			.string()
			.transform((val) => parseInt(val, 10))
			.pipe(z.number().int().positive())
			.default('3306'),
		DB_USER: z.string().min(1),
		DB_PASSWORD: z.string().min(1),
		DB_DATABASE: z.string().min(1),
		USING_DEVTOOLS: StrBool,
	},
	runtimeEnv: {
		NODE_ENV: process.env.NODE_ENV,
		DB_HOST: process.env.DB_HOST,
		DB_PORT: process.env.DB_PORT,
		DB_USER: process.env.DB_USER,
		DB_PASSWORD: process.env.DB_PASSWORD,
		DB_DATABASE: process.env.DB_DATABASE,
		USING_DEVTOOLS: process.env.USING_DEVTOOLS,
	},
})

export type Env = typeof ENV
