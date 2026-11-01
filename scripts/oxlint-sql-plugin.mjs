// oxlint rules for statements (src/server/sql.ts). A statement here is a call chain rooted at a binding of
// `Sql.forModule(...)` that starts with select, selectDistinct, insert, update or delete.
//
// - sql/no-async-statement: a statement is run by DB.all/get/run(ctx, stmt), synchronously. Awaiting it, chaining
//   .then/.catch/.finally, passing it to a promise aggregator, voiding it, returning it from an async function or
//   running it directly with .all()/.get()/.run() would reach drizzle's own execution, which throws at runtime.
// - sql/no-dropped-statement: a statement built and never run.
// - sql/no-module-builder: a builder stored at module level outside SQL.def, which callers could extend in place.
// - sql/statements-in-q: a module-level SQL.def or SQL.params outside the module's `namespace Q`, which keeps
//   statements apart from the functions that run them.
// - sql/one-for-module: Sql.forModule called more than once for one database in a file.
// - sql/no-reveal-in-statement: Secret.reveal() inside a statement built per call, which would bind the revealed value
//   where the logger cannot mask it. Declare the parameter with SQL.secret in a definition instead.
// - sql/no-dynamic-raw: sql.raw with anything but a string literal.
// - sql/no-placeholder: sql.placeholder, which SQL.params replaces.
// - sql/no-drizzle-instance: drizzle(...) outside src/server/db.ts.
const BUILDERS = new Set(['select', 'selectDistinct', 'insert', 'update', 'delete'])
const TERMINATORS = new Set(['all', 'get', 'run', 'execute'])
const PROMISE_METHODS = new Set(['then', 'catch', 'finally'])
const AGGREGATORS = new Set(['all', 'allSettled', 'race', 'any'])

const isForModuleCall = (node) =>
	node?.type === 'CallExpression' &&
	node.callee.type === 'MemberExpression' &&
	!node.callee.computed &&
	node.callee.property.name === 'forModule'

// the root identifier and methods of a call chain, outermost last
function chainOf(node) {
	const methods = []
	let cur = node
	while (cur?.type === 'CallExpression' && cur.callee.type === 'MemberExpression' && !cur.callee.computed) {
		methods.unshift(cur.callee.property.name)
		cur = cur.callee.object
	}
	return cur?.type === 'Identifier' ? { root: cur.name, methods } : null
}

function makeIsStatement(sqlNames) {
	return (node) => {
		const c = chainOf(node)
		return c !== null && sqlNames.has(c.root) && BUILDERS.has(c.methods[0])
	}
}

function collectSqlNames(program) {
	const names = new Set()
	for (const st of program.body) {
		const decl = st.type === 'ExportNamedDeclaration' ? st.declaration : st
		if (decl?.type !== 'VariableDeclaration') continue
		for (const d of decl.declarations) if (d.id.type === 'Identifier' && isForModuleCall(d.init)) names.add(d.id.name)
	}
	return names
}

const noAsyncStatement = {
	meta: {
		type: 'problem',
		messages: { misuse: 'Statements run synchronously: run it with DB.all/get/run(ctx, stmt) instead of {{how}}.' },
	},
	create(context) {
		let isStatement = () => false
		const bound = new Set()
		const isStmt = (node) => (node?.type === 'Identifier' ? bound.has(node.name) : isStatement(node))
		const report = (node, how) => context.report({ node, messageId: 'misuse', data: { how } })
		return {
			Program(node) {
				isStatement = makeIsStatement(collectSqlNames(node))
			},
			VariableDeclarator(node) {
				if (node.id.type === 'Identifier' && isStatement(node.init)) bound.add(node.id.name)
			},
			AwaitExpression(node) {
				if (isStmt(node.argument)) report(node, 'awaiting it')
			},
			UnaryExpression(node) {
				if (node.operator === 'void' && isStmt(node.argument)) report(node, 'voiding it')
			},
			CallExpression(node) {
				const callee = node.callee
				if (callee.type !== 'MemberExpression' || callee.computed) return
				const method = callee.property.name
				if (PROMISE_METHODS.has(method) && isStmt(callee.object)) report(node, `calling .${method}`)
				if (TERMINATORS.has(method) && isStmt(callee.object)) report(node, `calling .${method}() on it`)
				if (callee.object.type === 'Identifier' && callee.object.name === 'Promise' && AGGREGATORS.has(method)) {
					const arr = node.arguments[0]
					if (arr?.type === 'ArrayExpression' && arr.elements.some(isStmt)) report(node, `passing it to Promise.${method}`)
				}
			},
			ReturnStatement(node) {
				const fn = context.sourceCode.getAncestors(node).findLast((a) => a.type.includes('Function'))
				if (fn?.async && isStmt(node.argument)) report(node, 'returning it from an async function')
			},
			ArrowFunctionExpression(node) {
				if (node.async && node.body.type !== 'BlockStatement' && isStmt(node.body)) report(node, 'returning it from an async function')
			},
		}
	},
}

const noDroppedStatement = {
	meta: { type: 'problem', messages: { dropped: 'This statement is built and never run: run it with DB.all/get/run(ctx, stmt).' } },
	create(context) {
		let isStatement = () => false
		return {
			Program(node) {
				isStatement = makeIsStatement(collectSqlNames(node))
			},
			ExpressionStatement(node) {
				if (isStatement(node.expression)) context.report({ node, messageId: 'dropped' })
			},
		}
	},
}

const noModuleBuilder = {
	meta: {
		type: 'problem',
		messages: {
			stored: 'A builder kept at module level can be changed in place by its callers: wrap it in SQL.def, or build it in a function.',
		},
	},
	create(context) {
		return {
			Program(program) {
				const isStatement = makeIsStatement(collectSqlNames(program))
				for (const st of program.body) {
					const decl = st.type === 'ExportNamedDeclaration' ? st.declaration : st
					if (decl?.type !== 'VariableDeclaration') continue
					for (const d of decl.declarations) if (isStatement(d.init)) context.report({ node: d, messageId: 'stored' })
				}
			},
		}
	},
}

const statementsInQ = {
	meta: {
		type: 'problem',
		messages: { outside: "Define a module's statements and their parameters inside `namespace Q`." },
	},
	create(context) {
		return {
			Program(program) {
				const sqlNames = collectSqlNames(program)
				const isDefinition = (init) => {
					const c = chainOf(init)
					return c !== null && sqlNames.has(c.root) && (c.methods[0] === 'def' || c.methods[0] === 'params')
				}
				const check = (statements, inQ) => {
					for (const st of statements) {
						const decl = st.type === 'ExportNamedDeclaration' ? st.declaration : st
						if (decl?.type === 'TSModuleDeclaration' && decl.body?.type === 'TSModuleBlock') {
							check(decl.body.body, decl.id.type === 'Identifier' && decl.id.name === 'Q')
							continue
						}
						if (inQ || decl?.type !== 'VariableDeclaration') continue
						for (const d of decl.declarations) if (isDefinition(d.init)) context.report({ node: d, messageId: 'outside' })
					}
				}
				check(program.body, false)
			},
		}
	},
}

const oneForModule = {
	meta: { type: 'problem', messages: { twice: "Call Sql.forModule once per file and database, with this file's own module." } },
	create(context) {
		const seen = new Set()
		return {
			CallExpression(node) {
				if (!isForModuleCall(node) || node.callee.object.type !== 'Identifier' || node.callee.object.name !== 'Sql') return
				const opts = node.arguments[1]
				const dbProp = opts?.type === 'ObjectExpression' ? opts.properties.find((p) => p.key?.name === 'db') : undefined
				const db = dbProp?.value.type === 'Literal' ? String(dbProp.value.value) : 'main'
				if (seen.has(db)) context.report({ node, messageId: 'twice' })
				seen.add(db)
			},
		}
	},
}

const noRevealInStatement = {
	meta: {
		type: 'problem',
		messages: { reveal: 'A statement built per call binds what it is given unmasked: declare a SQL.secret parameter in a definition.' },
	},
	create(context) {
		let isStatement = () => false
		return {
			Program(node) {
				isStatement = makeIsStatement(collectSqlNames(node))
			},
			CallExpression(node) {
				const callee = node.callee
				if (callee.type !== 'MemberExpression' || callee.computed || callee.property.name !== 'reveal') return
				const ancestors = context.sourceCode.getAncestors(node)
				// inside a SQL.def, a statement is a definition
				if (
					ancestors.some(
						(a) => a.type === 'CallExpression' && a.callee.type === 'MemberExpression' && a.callee.property?.name === 'def',
					)
				)
					return
				if (ancestors.some((a) => isStatement(a))) context.report({ node, messageId: 'reveal' })
			},
		}
	},
}

const isSqlMember = (node, prop) =>
	node.type === 'MemberExpression' &&
	!node.computed &&
	node.object.type === 'Identifier' &&
	node.object.name === 'sql' &&
	node.property.name === prop

const noDynamicRaw = {
	meta: { type: 'problem', messages: { raw: 'sql.raw takes only a string literal: bind a value as a parameter.' } },
	create(context) {
		return {
			CallExpression(node) {
				if (!isSqlMember(node.callee, 'raw')) return
				const arg = node.arguments[0]
				const literal =
					(arg?.type === 'Literal' && typeof arg.value === 'string') ||
					(arg?.type === 'TemplateLiteral' && arg.expressions.length === 0)
				if (!literal) context.report({ node, messageId: 'raw' })
			},
		}
	},
}

const noPlaceholder = {
	meta: { type: 'problem', messages: { placeholder: 'Declare parameters with SQL.params, which checks and encodes them.' } },
	create(context) {
		return {
			MemberExpression(node) {
				if (isSqlMember(node, 'placeholder')) context.report({ node, messageId: 'placeholder' })
			},
		}
	},
}

const noDrizzleInstance = {
	meta: {
		type: 'problem',
		messages: { instance: 'Only src/server/db.ts opens drizzle on a connection; run statements through DB.all/get/run.' },
	},
	create(context) {
		if (context.filename.replaceAll('\\', '/').endsWith('src/server/db.ts')) return {}
		return {
			CallExpression(node) {
				if (node.callee.type === 'Identifier' && node.callee.name === 'drizzle') context.report({ node, messageId: 'instance' })
			},
		}
	},
}

export default {
	meta: { name: 'sql' },
	rules: {
		'no-async-statement': noAsyncStatement,
		'no-dropped-statement': noDroppedStatement,
		'no-module-builder': noModuleBuilder,
		'statements-in-q': statementsInQ,
		'one-for-module': oneForModule,
		'no-reveal-in-statement': noRevealInStatement,
		'no-dynamic-raw': noDynamicRaw,
		'no-placeholder': noPlaceholder,
		'no-drizzle-instance': noDrizzleInstance,
	},
}
