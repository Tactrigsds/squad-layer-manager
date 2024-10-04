import { createEnv } from '@t3-oss/env-core'
import dotenv from 'dotenv'
import { z } from 'zod'

dotenv.config()

export const ENV = createEnv({
	server: {
		DB_HOST: z.string().default('127.0.0.1'),
		DB_PORT: z
			.string()
			.transform((val) => parseInt(val, 10))
			.pipe(z.number().int().positive())
			.default('3306'),
		DB_USER: z.string().min(1),
		DB_PASSWORD: z.string().min(1),
		DB_DATABASE: z.string().min(1),
	},
	runtimeEnv: {
		DB_HOST: process.env.DB_HOST,
		DB_PORT: process.env.DB_PORT,
		DB_USER: process.env.DB_USER,
		DB_PASSWORD: process.env.DB_PASSWORD,
		DB_DATABASE: process.env.DB_DATABASE,
	},
})

export type Env = typeof ENV
