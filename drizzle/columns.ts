import type { Column } from 'drizzle-orm'
import { customType } from 'drizzle-orm/sqlite-core'
import superjson from 'superjson'

import { Secret, secretEncoders } from '@/lib/secret'

// Column types with an encoding of their own. Statement parameters declared with one of these columns encode through
// it (src/server/sql.ts).

/**
 * A JSON column holding a superjson envelope (`{ json, meta }`), read and written as `T`. Nothing checks the value
 * against `T`: a reader whose rows can hold old shapes declares `unknown` and parses the value with its model's
 * schema.
 */
export function superjsonColumn<T>(name: string) {
	return customType<{ data: T; driverData: string }>({
		dataType: () => 'text',
		toDriver: (v) => superjson.stringify(v),
		fromDriver: (text) => superjson.parse<T>(text),
	})(name)
}

/**
 * A text column that stores a secret: a read returns a Secret, and a write takes one, so a whole row returned to a
 * client throws in the serializer instead of carrying the value.
 */
export function secretColumn(name: string) {
	const toDriver = (v: Secret<string>) => {
		if (!(v instanceof Secret)) throw new TypeError(`column ${name} stores a secret, and takes a Secret`)
		return v.reveal()
	}
	secretEncoders.add(toDriver)
	return customType<{ data: Secret<string>; driverData: string }>({
		dataType: () => 'text',
		toDriver,
		fromDriver: (text) => new Secret(text),
	})(name)
}

const unloggedColumns = new WeakSet<Column>()

/**
 * Keeps each column's values out of the development debug log of a statement's values. For a column whose value
 * grants access but is no Secret, such as a session id or a settings document holding sealed credentials.
 */
export function unlogged(...cols: Column[]) {
	for (const c of cols) unloggedColumns.add(c)
}

export function isUnlogged(col: Column) {
	return unloggedColumns.has(col)
}
