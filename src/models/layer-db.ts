import type { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3'
import type { drizzle as drizzleSqlitePRoxy } from 'drizzle-orm/sqlite-proxy'
// export type LayerDb= ReturnType<typeof drizzleSqlitePRoxy> | ReturnType<typeof drizzleSqlite>
export type LayerDb= ReturnType<typeof drizzleSqlite>
