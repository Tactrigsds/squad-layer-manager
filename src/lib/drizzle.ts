import { AnyColumn } from 'drizzle-orm'
import { MySqlTableWithColumns, TableConfig, getTableConfig } from 'drizzle-orm/mysql-core'
import { z } from 'zod'
import superjson from 'superjson'
export type Error = {
	code: string
}

export async function returnInsertErrors<T>(runningQuery: Promise<T[]>) {
	try {
		return { code: 'ok' as const, data: (await runningQuery)[0] }
	} catch (_err: unknown) {
		const err = _err as { code: 'ER_DUP_ENTRY' }
		if (err.code === 'ER_DUP_ENTRY') {
			// const pgError = err as Error
			return {
				code: 'already-exists' as const,
				// tableName: pgError.table_name!,
				// constraintName: pgError.constraint_name!,
				// err: pgError,
			}
		}
		throw err
	}
}

export function superjsonify<C extends TableConfig, T extends Partial<MySqlTableWithColumns<TableConfig>['$inferInsert']>>(
	schema: MySqlTableWithColumns<C>,
	obj: T
) {
	const out = {} as typeof obj
	const config = getTableConfig(schema)
	for (const name of Object.keys(obj)) {
		const column = config.columns.find((c) => c.name === name)
		if (!column) throw new Error(`Column ${name} not found in table ${config.baseName}`)
		if (column.columnType === 'json') {
			//@ts-expect-error idk
			out[name] = superjson.serialize(obj[name])
		} else {
			//@ts-expect-error idk
			out[name] = obj[name]
		}
	}
	return out
}

export function unsuperjsonify<C extends TableConfig>(schema: MySqlTableWithColumns<C>, obj: any) {
	const out = {} as Record<string, any>
	const config = getTableConfig(schema)
	for (const name of Object.keys(obj)) {
		const column = config.columns.find((c) => c.name === name)
		if (!column) throw new Error(`Column ${name} not found in table ${config.baseName}`)
		if (column.columnType === 'json') {
			out[name] = superjson.deserialize(obj[name])
		} else {
			out[name] = obj[name]
		}
	}
	return out
}

// assumes single row update
export async function returnUpdateErrors<T = never>(runningQuery: Promise<T[]>) {
	const rows = await runningQuery
	if (rows.length === 0) {
		return { code: 'err:not-found' as const, err: new Error() }
	}
	return { code: 'ok' as const, data: rows[0] }
}
