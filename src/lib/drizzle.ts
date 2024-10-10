export type Error = {
	code: string
}

export async function returnInsertErrors<T>(runningQuery: Promise<T[]>) {
	try {
		return { code: 'success' as const, data: (await runningQuery)[0] }
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

// assumes single row update
export async function returnUpdateErrors<T = never>(runningQuery: Promise<T[]>) {
	const rows = await runningQuery
	if (rows.length === 0) {
		return { code: 'not-found' as const, err: new Error() }
	}
	return { code: 'success' as const, data: rows[0] }
}
