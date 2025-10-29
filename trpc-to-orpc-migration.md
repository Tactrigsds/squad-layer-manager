# Migrating from tRPC to oRPC: Router and Endpoint Guide

This guide provides the mechanical steps for migrating from tRPC to oRPC, focusing on router and endpoint transformations using Zod for validation.

## Installation and dependency changes

Replace tRPC packages with oRPC:

```bash
# Remove tRPC
npm uninstall @trpc/server @trpc/client @trpc/react-query superjson

# Install oRPC
npm install @orpc/server@latest @orpc/client@latest
npm install @orpc/tanstack-query@latest  # If using TanStack Query
npm install zod  # If not already installed
```

You can remove the superjson dependency entirely since oRPC handles serialization natively.

## Converting initialization and context

**tRPC initialization:**

```typescript
// tRPC initialization
import { initTRPC } from '@trpc/server'
import superjson from 'superjson'

const t = initTRPC.context<typeof createRPCContext>().create({
	transformer: superjson,
})

export const createTRPCRouter = t.router

const timingMiddleware = t.middleware(async ({ next, path }) => {
	const start = Date.now()
	const result = await next()
	console.log(`[tRPC] ${path} took ${Date.now() - start}ms`)
	return result
})

export const publicProcedure = t.procedure.use(timingMiddleware)
```

**oRPC equivalent:**

```typescript
// oRPC initialization
import { os } from '@orpc/server'

const o = os.$context<Awaited<ReturnType<typeof createRPCContext>>>()

const timingMiddleware = o.middleware(async ({ next, path }) => {
	const start = Date.now()
	try {
		return await next()
	} finally {
		console.log(`[oRPC] ${path} took ${Date.now() - start}ms`)
	}
})

export const publicProcedure = o.use(timingMiddleware)
```

**Key changes:**

- Middleware receives `context` instead of `ctx`
- No router factory needed
- No transformer configuration required

## Transforming procedure definitions with Zod

**tRPC router:**

```typescript
// tRPC router
import { z } from 'zod'
import { createTRPCRouter, protectedProcedure, publicProcedure } from './trpc'

export const planetRouter = createTRPCRouter({
	list: publicProcedure
		.input(z.object({
			cursor: z.number().int().default(0),
			limit: z.number().int().min(1).max(100).default(10),
		}))
		.query(({ input }) => {
			return {
				planets: [{ name: 'Earth' }],
				nextCursor: input.cursor + input.limit,
			}
		}),

	find: publicProcedure
		.input(z.object({ id: z.number().int() }))
		.query(({ input }) => {
			return { id: input.id, name: 'Earth', distance: 1 }
		}),

	create: protectedProcedure
		.input(z.object({
			name: z.string().min(1),
			distance: z.number().positive(),
		}))
		.mutation(async ({ ctx, input }) => {
			return ctx.db.planet.create({ data: input })
		}),

	update: protectedProcedure
		.input(z.object({
			id: z.number().int(),
			name: z.string().min(1).optional(),
			distance: z.number().positive().optional(),
		}))
		.mutation(async ({ ctx, input }) => {
			return ctx.db.planet.update({
				where: { id: input.id },
				data: input,
			})
		}),
})
```

**oRPC router:**

```typescript
// oRPC router
import { z } from 'zod'
import { protectedProcedure, publicProcedure } from './orpc'

export const planetRouter = {
	list: publicProcedure
		.input(z.object({
			cursor: z.number().int().default(0),
			limit: z.number().int().min(1).max(100).default(10),
		}))
		.handler(({ input }) => {
			return {
				planets: [{ name: 'Earth' }],
				nextCursor: input.cursor + input.limit,
			}
		}),

	find: publicProcedure
		.input(z.object({ id: z.number().int() }))
		.handler(({ input }) => {
			return { id: input.id, name: 'Earth', distance: 1 }
		}),

	create: protectedProcedure
		.input(z.object({
			name: z.string().min(1),
			distance: z.number().positive(),
		}))
		.handler(async ({ context, input }) => {
			return context.db.planet.create({ data: input })
		}),

	update: protectedProcedure
		.input(z.object({
			id: z.number().int(),
			name: z.string().min(1).optional(),
			distance: z.number().positive().optional(),
		}))
		.handler(async ({ context, input }) => {
			return context.db.planet.update({
				where: { id: input.id },
				data: input,
			})
		}),
}
```

**Mechanical changes:**

1. Remove `createTRPCRouter()` wrapper
2. Replace `.query()` and `.mutation()` with `.handler()`
3. Rename `ctx` to `context`

## Working with nested routers

**tRPC nested routers:**

```typescript
export const appRouter = createTRPCRouter({
	planet: planetRouter,
	user: userRouter,
	post: createTRPCRouter({
		list: publicProcedure.query(() => []),
		create: protectedProcedure
			.input(z.object({ title: z.string() }))
			.mutation(({ input }) => ({ id: 1, ...input })),
	}),
})
```

**oRPC nested routers:**

```typescript
export const appRouter = {
	planet: planetRouter,
	user: userRouter,
	post: {
		list: publicProcedure.handler(() => []),
		create: protectedProcedure
			.input(z.object({ title: z.string() }))
			.handler(({ input }) => ({ id: 1, ...input })),
	},
}
```

**Changes:**

- Use plain objects instead of `createTRPCRouter()`
- Replace `.query()` and `.mutation()` with `.handler()`

## Adding output validation with Zod

**tRPC:**

```typescript
const getPlanet = publicProcedure
	.input(z.object({ id: z.number() }))
	.output(z.object({
		id: z.number(),
		name: z.string(),
		distance: z.number(),
	}))
	.query(({ input }) => {
		return { id: input.id, name: 'Earth', distance: 1 }
	})
```

**oRPC:**

```typescript
const getPlanet = publicProcedure
	.input(z.object({ id: z.number() }))
	.output(z.object({
		id: z.number(),
		name: z.string(),
		distance: z.number(),
	}))
	.handler(({ input }) => {
		return { id: input.id, name: 'Earth', distance: 1 }
	})
```

**Changes:**

- Replace `.query()` with `.handler()`

## Handling authentication middleware

**tRPC:**

```typescript
const protectedProcedure = publicProcedure.use(async ({ ctx, next }) => {
	if (!ctx.session?.user) {
		throw new TRPCError({ code: 'UNAUTHORIZED' })
	}
	return next({
		ctx: {
			...ctx,
			user: ctx.session.user,
		},
	})
})
```

**oRPC:**

```typescript
const protectedProcedure = publicProcedure.use(async ({ context, next }) => {
	if (!context.session?.user) {
		throw new ORPCError('UNAUTHORIZED')
	}
	return next({
		context: {
			...context,
			user: context.session.user,
		},
	})
})
```

**Changes:**

- Rename `ctx` to `context`
- Change error syntax: `new ORPCError('CODE', { message })` vs `new TRPCError({ code: 'CODE', message })`

## Complex router example with multiple features

**tRPC:**

```typescript
const userRouter = createTRPCRouter({
	getProfile: publicProcedure
		.input(z.object({ userId: z.string() }))
		.output(z.object({
			id: z.string(),
			name: z.string(),
			email: z.string().email(),
			createdAt: z.date(),
		}))
		.query(async ({ ctx, input }) => {
			return ctx.db.user.findUnique({
				where: { id: input.userId },
			})
		}),

	updateProfile: protectedProcedure
		.input(z.object({
			name: z.string().optional(),
			bio: z.string().max(500).optional(),
		}))
		.mutation(async ({ ctx, input }) => {
			return ctx.db.user.update({
				where: { id: ctx.user.id },
				data: input,
			})
		}),

	uploadAvatar: protectedProcedure
		.input(z.object({
			base64Image: z.string(),
		}))
		.mutation(async ({ ctx, input }) => {
			const url = await uploadToS3(input.base64Image)
			return { avatarUrl: url }
		}),
})
```

**oRPC:**

```typescript
const userRouter = {
	getProfile: publicProcedure
		.input(z.object({ userId: z.string() }))
		.output(z.object({
			id: z.string(),
			name: z.string(),
			email: z.string().email(),
			createdAt: z.date(),
		}))
		.handler(async ({ context, input }) => {
			return context.db.user.findUnique({
				where: { id: input.userId },
			})
		}),

	updateProfile: protectedProcedure
		.input(z.object({
			name: z.string().optional(),
			bio: z.string().max(500).optional(),
		}))
		.handler(async ({ context, input }) => {
			return context.db.user.update({
				where: { id: context.user.id },
				data: input,
			})
		}),

	uploadAvatar: protectedProcedure
		.input(z.object({
			file: z.instanceof(File), // Native File support
		}))
		.handler(async ({ context, input }) => {
			const url = await uploadToS3(input.file)
			return { avatarUrl: url }
		}),
}
```

**Changes:**

- Remove `createTRPCRouter()` wrapper
- Replace `.query()` and `.mutation()` with `.handler()`
- Rename `ctx` to `context`
- Can use native File type with `z.instanceof(File)`

## Migrating client calls

**tRPC client:**

```typescript
const client = createTRPCProxyClient<typeof appRouter>({
	links: [httpLink({ url: 'http://localhost:3000/api/trpc' })],
})

const { planets } = await client.planet.list.query({ cursor: 0 })
await client.planet.create.mutate({ name: 'Mars' })
```

**oRPC client:**

```typescript
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { RouterClient } from '@orpc/server'

const link = new RPCLink({ url: 'http://localhost:3000/api/orpc' })
export const client: RouterClient<typeof appRouter> = createORPCClient(link)

const { planets } = await client.planet.list({ cursor: 0 })
await client.planet.create({ name: 'Mars' })
```

**Changes:**

- Remove `.query()` and `.mutate()` suffixes
- Call procedures directly like regular functions
- Use `RPCLink` instead of `httpLink`
- Use `createORPCClient` instead of `createTRPCProxyClient`

## Transforming TanStack Query usage

**tRPC with TanStack Query:**

```typescript
import { createTRPCReact } from '@trpc/react-query'

export const trpc = createTRPCReact<typeof appRouter>()

// In _app.tsx
function App({ Component, pageProps }) {
	const [queryClient] = useState(() => new QueryClient())
	const [trpcClient] = useState(() =>
		trpc.createClient({
			links: [httpLink({ url: '/api/trpc' })],
		})
	)

	return (
		<trpc.Provider client={trpcClient} queryClient={queryClient}>
			<QueryClientProvider client={queryClient}>
				<Component {...pageProps} />
			</QueryClientProvider>
		</trpc.Provider>
	)
}

// In component
function PlanetList() {
	const query = trpc.planet.list.useQuery({ cursor: 0 })
	// ...
}
```

**oRPC with TanStack Query:**

```typescript
import { createTanstackQueryUtils } from '@orpc/tanstack-query'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'

export const orpc = createTanstackQueryUtils(client)

// In _app.tsx - no oRPC provider needed
function App({ Component, pageProps }) {
	const [queryClient] = useState(() => new QueryClient())

	return (
		<QueryClientProvider client={queryClient}>
			<Component {...pageProps} />
		</QueryClientProvider>
	)
}

// In component - use TanStack Query hooks directly
function PlanetList() {
	const query = useQuery(orpc.planet.list.queryOptions({
		input: { cursor: 0 },
	}))
	// ...
}
```

**Changes:**

- Remove tRPC provider wrapper
- Use standard TanStack Query hooks (`useQuery`, `useMutation`)
- Use `.queryOptions()` or `.mutationOptions()` helper methods
- Wrap parameters in `input` object

### Mutations with TanStack Query

**tRPC mutations:**

```typescript
// Direct mutation call
await trpc.planet.create.mutate({ name: 'Mars' })

// In component with useMutation hook
function CreatePlanet() {
	const mutation = trpc.planet.create.useMutation()

	const handleCreate = () => {
		mutation.mutate({ name: 'Mars' }, {
			onSuccess: (data) => console.log('Created:', data),
			onError: (error) => console.error('Failed:', error),
		})
	}

	return <button onClick={handleCreate}>Create Planet</button>
}
```

**oRPC mutations:**

```typescript
// Direct mutation call - same interface
await orpc.planet.create({ name: 'Mars' })

// In component with TanStack Query useMutation hook
import { useMutation } from '@tanstack/react-query'

function CreatePlanet() {
	const mutation = useMutation({
		mutationFn: (input) => orpc.planet.create(input),
		onSuccess: (data) => console.log('Created:', data),
		onError: (error) => console.error('Failed:', error),
	})

	const handleCreate = () => {
		mutation.mutate({ name: 'Mars' })
	}

	return <button onClick={handleCreate}>Create Planet</button>
}
```

**Key differences:**

- oRPC mutations are **just regular async functions** - no special mutation wrapper
- Use standard TanStack Query `useMutation()` instead of `trpc.*.useMutation()`
- No `.mutate()` or `.mutateAsync()` methods on the procedure - call it directly
- Wrap the procedure call in `mutationFn` for TanStack Query

### Complex mutations with TanStack Query integration

**Pattern for mutations with multiple inputs (tuples):**

```typescript
// Server procedure accepting a tuple input
export const updateFilter = orpcBase
	.input(z.tuple([
		z.string(), // id
		z.object({ name: z.string().optional() }), // updates
	]))
	.handler(async ({ input, context }) => {
		const [id, updates] = input
		// Update logic here
		return { success: true, filter: { id, ...updates } }
	})

// Client-side with TanStack Query
function UpdateFilter() {
	const mutation = useMutation({
		mutationFn: (input: Parameters<typeof orpc.filters.updateFilter>[0]) => orpc.filters.updateFilter(input),
		onSuccess: (data) => {
			// Invalidate related queries
			reactQueryClient.invalidateQueries({
				queryKey: ['filters', 'list'],
			})
		},
	})

	const handleUpdate = (filterId: string, updates: UpdateInput) => {
		mutation.mutate([filterId, updates])
	}

	return (
		<button onClick={() => handleUpdate('123', { name: 'New Name' })}>
			Update
		</button>
	)
}
```

**Pattern for mutations coordinated with subscriptions:**

```typescript
// Server subscription
export const watchFilters = orpcBase.handler(async function*({ context, signal }) {
	yield initialValue
	for await (const mutation of subscriptionStream) {
		yield mutation
	}
})

// Client-side subscription helper for oRPC async generators
import { fromOrpcSubscription } from '@/lib/async'

export const filterMutation$ = new Rx.Observable<Mutation>((subscriber) => {
	const subscription = fromOrpcSubscription(() => orpc.filters.watchFilters())
		.subscribe({
			next: (value) => subscriber.next(value),
			error: (err) => subscriber.error(err),
			complete: () => subscriber.complete(),
		})
	return () => subscription.unsubscribe()
}).pipe(shareReplay())

// In component - mutations trigger subscription updates automatically
export function useFilterCreate() {
	return useMutation({
		mutationFn: (input: Parameters<typeof orpc.filters.createFilter>[0]) => orpc.filters.createFilter(input),
		onSuccess: () => {
			// Subscription already handles state updates via the server
			// No additional cache invalidation needed if using subscriptions
		},
	})
}
```

**Pattern for type-safe mutations with inference:**

```typescript
// When TypeScript can't infer types through useMutation,
// explicitly type the mutation function using Parameters helper:

export function useFilterCreate() {
	return useMutation({
		mutationFn: (input: Parameters<typeof orpc.filters.createFilter>[0]) => orpc.filters.createFilter(input),
	})
}

export function useFilterDelete() {
	return useMutation({
		mutationFn: (filterId: string) => orpc.filters.deleteFilter(filterId),
	})
}

// Or with full type annotation for complex objects:
interface FilterContributor {
	filterId: string
	userId?: bigint
	role?: string
}

export function useAddFilterContributor() {
	return useMutation({
		mutationFn: (input: FilterContributor) => orpc.filters.addFilterContributor(input),
	})
}
```

**Helper utility for oRPC subscriptions (create once, reuse everywhere):**

```typescript
// In src/lib/async.ts
import * as Rx from 'rxjs'

export function fromOrpcSubscription<T>(
	task: () => Promise<AsyncGenerator<T>>,
): Rx.Observable<T> {
	return new Rx.Observable<T>((subscriber) => {
		const promise = task()
		promise.then(async (generator) => {
			try {
				for await (const value of generator) {
					subscriber.next(value)
				}
				subscriber.complete()
			} catch (error) {
				subscriber.error(error)
			}
		}).catch((error) => {
			subscriber.error(error)
		})
	})
}

// Usage everywhere:
// fromOrpcSubscription(() => orpc.filters.watchFilters())
```

**Mutations changes summary:**

- Procedures are called directly as async functions, not via `.mutate()` wrapper
- Use standard TanStack Query `useMutation()` hook with explicit `mutationFn`
- For complex inputs, use tuple unpacking or `Parameters<typeof procedure>` for types
- Create `fromOrpcSubscription()` utility once to convert oRPC's `Promise<AsyncGenerator>` to RxJS `Observable`
- Handle cache invalidation with TanStack Query's standard tools
- Mutations can coordinate with subscriptions for real-time updates

### Infinite queries

**tRPC:**

```typescript
const query = trpc.planet.list.useInfiniteQuery(
	{ limit: 10 }, // Static input
	{
		getNextPageParam: (lastPage) => lastPage.nextCursor,
	},
)
```

**oRPC:**

```typescript
const query = useInfiniteQuery(
	orpc.planet.list.infiniteOptions({
		input: (pageParam: number | undefined) => ({
			cursor: pageParam,
			limit: 10,
		}),
		initialPageParam: undefined,
		getNextPageParam: (lastPage) => lastPage.nextCursor,
	}),
)
```

**Changes:**

- Use standard `useInfiniteQuery` hook
- Use `.infiniteOptions()` helper
- Input becomes a function: `(pageParam) => ({ ... })`
- Must specify `initialPageParam`

## Handling subscriptions and streaming

**tRPC:**

```typescript
const subscription = publicProcedure
	.subscription(() => {
		return observable<string>((emit) => {
			const timer = setInterval(() => {
				emit.next('tick')
			}, 1000)
			return () => clearInterval(timer)
		})
	})
```

**oRPC (using async generators):**

```typescript
const subscription = publicProcedure
	.handler(async function*() {
		while (true) {
			yield 'tick'
			await new Promise(resolve => setTimeout(resolve, 1000))
		}
	})
```

**Changes:**

- Replace `.subscription()` with `.handler()`
- Use async generators instead of observables

## Critical breaking changes and gotchas

### Client context exclusion

Client context is excluded from query keys by default. If context affects responses (like user-specific data), manually include context in query keys:

```typescript
const query = useQuery({
	...orpc.planet.list.queryOptions({
		input: { cursor: 0 },
		context: { userId: currentUser.id },
	}),
	queryKey: ['planet', 'list', { cursor: 0, userId: currentUser.id }],
})
```

### Error code compatibility

Error codes remain compatible between tRPC and oRPC. Just update the constructor syntax:

- tRPC: `new TRPCError({ code: 'UNAUTHORIZED', message: 'text' })`
- oRPC: `new ORPCError('UNAUTHORIZED', { message: 'text' })`

### Middleware execution order

If you rely on specific middleware order relative to validation, use `$config({ initialInputValidationIndex, initialOutputValidationIndex })` to control when validation occurs in the middleware chain.

## Migration workflow recommendations

**For small projects** (under 50 procedures):

1. Update package.json dependencies
2. Run a global find/replace: `.query(` → `.handler(`, `.mutation(` → `.handler(`
3. Run a find/replace: `{ ctx,` → `{ context,`
4. Remove all `createTRPCRouter()` wrappers
5. Update error constructors: `TRPCError` → `ORPCError`
6. Update client calls (remove `.query()` and `.mutate()` suffixes)
7. Update TanStack Query integration
8. Test thoroughly

**For medium/large projects:**

1. Create a separate branch for migration
2. Migrate routers one at a time, testing each
3. Update client code in parallel
4. Use TypeScript errors as a guide—the compiler will catch most issues
5. Update tests as you go

**Timeline estimates:**

- Small projects: 2-4 hours
- Medium projects (50-200 procedures): half to one day
- Large projects (200+ procedures): 2-3 days

## Best practices for the new codebase

### Use the builder pattern for reusable base procedures

```typescript
const baseProcedure = os.$context<Context>()
const authedProcedure = baseProcedure.use(authMiddleware)
const adminProcedure = authedProcedure.use(adminMiddleware)
```

### Take advantage of native type support

```typescript
// No superjson needed - these just work
const procedure = publicProcedure
	.input(z.object({
		date: z.date(),
		file: z.instanceof(File),
		bigInt: z.bigint(),
	}))
	.handler(({ input }) => {
		// All native types preserved
		return { received: input }
	})
```

## Quick reference: Common replacements

| tRPC                             | oRPC                                                            |
| -------------------------------- | --------------------------------------------------------------- |
| `createTRPCRouter({ ... })`      | `{ ... }` (plain object)                                        |
| `.query()`                       | `.handler()`                                                    |
| `.mutation()`                    | `.handler()`                                                    |
| `.subscription()`                | `.handler()` with async generator                               |
| `{ ctx, input }`                 | `{ context, input }`                                            |
| `new TRPCError({ code })`        | `new ORPCError('CODE')`                                         |
| `client.procedure.query(input)`  | `client.procedure(input)`                                       |
| `client.procedure.mutate(input)` | `client.procedure(input)`                                       |
| `trpc.procedure.useQuery(input)` | `useQuery(orpc.procedure.queryOptions({ input }))`              |
| `trpc.procedure.useMutation()`   | `useMutation({ mutationFn: (input) => orpc.procedure(input) })` |
| `trpc.procedure.subscribe()`     | `fromOrpcSubscription(() => orpc.procedure())`                  |
| `superjson` transformer          | Built-in (remove dependency)                                    |

### Mutations Quick Reference

| Pattern            | tRPC                              | oRPC                                                         |
| ------------------ | --------------------------------- | ------------------------------------------------------------ |
| Direct call        | `await trpc.create.mutate(input)` | `await orpc.create(input)`                                   |
| In component       | `trpc.create.useMutation()`       | `useMutation({ mutationFn: (input) => orpc.create(input) })` |
| Tuple input        | Not typical                       | `mutation.mutate([id, updates])`                             |
| Type inference     | Auto-inferred                     | Use `Parameters<typeof orpc.procedure>[0]`                   |
| Error handling     | In mutation callback              | Standard TanStack Query `onError`                            |
| Cache invalidation | Via TanStack Query                | `reactQueryClient.invalidateQueries({...})`                  |

### Subscriptions Quick Reference

| Pattern               | tRPC                                                           | oRPC                                               |
| --------------------- | -------------------------------------------------------------- | -------------------------------------------------- |
| Direct subscribe      | `trpc.watch.subscribe(input, { onData, onError, onComplete })` | `await orpc.watch(input)` returns `AsyncGenerator` |
| Convert to Observable | `fromTrpcSub(input, trpc.watch.subscribe)`                     | `fromOrpcSubscription(() => orpc.watch(input))`    |
| In React component    | `trpc.watch.useSubscription(input)`                            | Use `fromOrpcSubscription()` with RxJS             |
| With state management | Manual Observable                                              | RxJS `Observable` with `.pipe(...)` operators      |

## Key Takeaways for Successful Migration

1. **Mutations are just functions** - No special mutation wrapper like tRPC has. Call procedures directly and wrap in `useMutation()` for TanStack Query.

2. **Subscriptions return async generators** - oRPC subscriptions return `Promise<AsyncGenerator<T>>`. Create the `fromOrpcSubscription()` helper once to convert to RxJS Observable.

3. **Type inference may need help** - Use `Parameters<typeof procedure>[0]` when TypeScript can't infer types through `useMutation()`.

4. **TanStack Query is standard** - No oRPC provider wrapper needed. Just use standard TanStack Query hooks everywhere.

5. **Cache invalidation is explicit** - Use `reactQueryClient.invalidateQueries()` to control when queries are refetched.

6. **Complex inputs use tuples** - Pass `[id, updates]` as tuple and destructure in handler: `const [id, updates] = input`

### Callable procedures

Where there's a function we want to use both as a procedure and a standalone function, we can now use OrpcServer.Call instead of having to create the procedure from a function separately. Let's do this wherever we can in the codebase.
