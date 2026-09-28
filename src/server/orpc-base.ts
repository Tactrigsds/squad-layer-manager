import * as Otel from '@opentelemetry/api'
import { os } from '@orpc/server'
import type Pino from 'pino'

import { getChildModule, type OtelModule } from '@/lib/otel.ts'
import * as Prom from '@/lib/promise-utils'
import * as Rx from '@/lib/rxjs'
import * as AppEvents from '@/models/app-events.models'
import * as ATTRS from '@/models/otel-attrs'
import * as PA from '@/models/procedure-access.models'
import * as RBAC from '@/rbac.models'

import type * as C from './context.ts'
import * as Instr from './instrumentation.ts'

type OrpcMeta = { logLevel?: Pino.Level; type?: 'query' | 'mutation' }

// rbac.server builds its own router from getOrpcBase at module init, so a static import back into it would evaluate
// rbac.server before this module has defined getOrpcBase
const rbacServer = () => import('@/systems/rbac.server')
const appEventsServer = () => import('@/systems/app-events.server')

const AsyncGeneratorFunction = Object.getPrototypeOf(async function* () {}).constructor

// validation first, so every middleware sees the parsed input rather than whatever arrived over the socket
const base = os.$config({ initialInputValidationIndex: Number.NEGATIVE_INFINITY }).$context<C.OrpcBase>().$meta<OrpcMeta>({})

export const getOrpcBase = (module: OtelModule) => {
	const submodule = getChildModule(module, 'orpc')
	const spanOpMiddleware = base.middleware((opts) => {
		type Opts = typeof opts
		const meta = opts.procedure['~orpc'].meta
		const eventLevel = meta?.logLevel ?? (meta?.type === 'mutation' ? 'info' : 'debug')
		return Instr.spanOp(
			opts.path[opts.path.length - 1],
			{
				module: submodule,
				kind: Otel.SpanKind.SERVER,
				levels: { error: 'error', event: eventLevel },
				attrs: (ctx, o) => ({ [ATTRS.Orpc.PATH]: o.path.join('/') }),
			},
			async (ctx: Opts['context'], opts: Opts) => {
				// narrow the connection-level signal to also abort with this particular call
				return opts.next({ context: { ...ctx, signal: Prom.anySignal(ctx.signal, opts.signal)! } })
			},
		)(opts.context, opts)
	})

	// Enforces the procedure's entry in PROCEDURE_ACCESS. A denied call answers with the denial as its output. A denied
	// stream yields the denial and then waits, rather than ending, since the client resubscribes to a stream that ends:
	// it ends only once access comes back, so the resubscription is the one that succeeds.
	const accessMiddleware = base.middleware(async ({ context: ctx, path, procedure, next }, input, output) => {
		const procedurePath = path.join('.')
		const access = PA.getAccess(procedurePath)
		if (!access) throw new Error(`no access declared for procedure ${procedurePath}`)
		const req = RBAC.Access.resolve(access, input)
		Instr.setSpanOpAttrs({ [ATTRS.Orpc.ACCESS]: access.kind })
		const isStream = procedure['~orpc'].handler instanceof AsyncGeneratorFunction
		const isMutation = procedure['~orpc'].meta?.type === 'mutation'

		const Rbac = await rbacServer()
		const check = req ? () => Rbac.tryDenyPermissionsForUser(ctx, req) : undefined
		const denial = check ? await check() : null

		if (denial) {
			Instr.setSpanOpAttrs({ [ATTRS.Orpc.DENIED]: true })
			if (isMutation) await recordDenial(ctx, procedurePath, denial)
			if (!isStream) return output(denial)
			return output(heldDenial(ctx, check!, denial))
		}

		const res = await next()
		if (isStream && check) return { ...res, output: guardStream(ctx, check, res.output as AsyncIterator<unknown>) }
		if (isMutation && RBAC.isPermissionDenied(res.output)) {
			Instr.setSpanOpAttrs({ [ATTRS.Orpc.DENIED]: true })
			await recordDenial(ctx, procedurePath, res.output)
		}
		return res
	})

	return base.use(spanOpMiddleware).use(accessMiddleware)
}

type AccessCheck = () => Promise<RBAC.PermissionDeniedResponse | null>

// resolves on the next change to this user's permissions that leaves `check` in the state `want` describes
async function accessBecomes(ctx: C.OrpcBase, check: AccessCheck, want: 'granted' | 'denied', signal: AbortSignal) {
	const Rbac = await rbacServer()
	return await Rx.Ext.firstValueFrom(
		Rbac.userInvalidation$(ctx.user.discordId).pipe(
			Rx.concatMap(check),
			Rx.filter((denial) => (want === 'granted' ? denial === null : denial !== null)),
		),
		signal,
	)
}

async function* heldDenial(ctx: C.OrpcBase, check: AccessCheck, denial: RBAC.PermissionDeniedResponse) {
	yield denial
	await accessBecomes(ctx, check, 'granted', ctx.signal).catch(Prom.rethrowUnlessAborted)
}

// Forwards the stream until the caller loses access, then yields the denial in its place and holds as heldDenial does.
// The handler's own stream is left to end with the call's signal: an async generator cannot be returned from while it
// is waiting on its next value.
async function* guardStream(ctx: C.OrpcBase, check: AccessCheck, inner: AsyncIterator<unknown>) {
	// scoped to this stream, so the permission watch ends with it rather than with the connection
	const watching = new AbortController()
	const revoked = accessBecomes(ctx, check, 'denied', AbortSignal.any([ctx.signal, watching.signal])).then(
		(denial) => ({ denial }),
		// aborted: the stream is over one way or the other, and the loop below ends on its own
		() => new Promise<never>(() => {}),
	)
	try {
		while (true) {
			const step = await Promise.race([inner.next().then((r) => ({ r })), revoked])
			if ('denial' in step) {
				Promise.resolve(inner.return?.(undefined)).catch(() => {})
				yield* heldDenial(ctx, check, step.denial!)
				return
			}
			if (step.r.done) return step.r.value
			yield step.r.value
		}
	} finally {
		watching.abort()
	}
}

async function recordDenial(ctx: C.OrpcBase, procedurePath: string, denial: RBAC.PermissionDeniedResponse) {
	const AppEventsSys = await appEventsServer()
	await AppEventsSys.persistAppEvent(
		ctx,
		AppEvents.create<AppEvents.PermissionDenied>({
			type: 'PERMISSION_DENIED',
			actor: { type: 'slm-user', userId: ctx.user.discordId },
			serverId: null,
			matchId: null,
			causeId: null,
			procedure: procedurePath,
			failures: denial.failures,
		}),
	)
}
