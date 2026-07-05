# General Guidelines

Any breaking changes to persisted data structures on either the frontend(localStorage) or the backend(database,config,environment variables) need to be explicitely flagged to the user so they can be dealt with.

Prefer copy-on-write in most cases unless it's proven to be safe to do so, or is in a hot codepath.

Async functions should by-default have the option to pass a signal to cancel an operation. if it's a non-lib function, the signal should be passed via the ctx object (see src/models/context-shared.ts). The client is not yet converted to this pattern, so use your best judgement on when to upgrade a function.

When branching on unions(especially discriminated unions), generally use assertNever() from src/lib/type-guards.ts to cover off the default case so that type errors are raised if we add new members to the union.

Unit tests should be reserved for complex and self-contained behavior that we want to isolate. we will be introducing integration tests at a later time.

Use namespace imports for all nontrivial modules, unless established convention for that module contradicts this. Make sure that the chosen namespace is consistent and unique across the app, except for special cases like things imported into context.ts or context-shared.ts. Use convenient abbreviations or acronyms for commonly used lib modules, model modules, and imported packages

# Server side

Significant actions taken by the user or by the system need to be logged via app events (see src/models/app-events.models.ts)

Commonly passed pieces of state should passed via the ctx object, which should always be the first argument, or in the case of observables, always the first element of the observable's data's tuple. Always check what's already available in context.ts and context-shared.ts before expanding it

Functions should only specify the minimal amount of context that they need in the ctx parameter type signature.

# Client side

In components, prefer modifying or adding selectors over computing intermediate state in the component body with useMemo. `ZusUtils.useStore` is helpful here, as it allows you to merge multiple data sources together for use in a single selector.

Use the established convention of `Sel` namespaces for selectors.

useEffects should be rare, and should be used mainly for subscribing to dom events. Using them to call setState when one of the dependencies change is heavily discouraged.

Generally speaking, actions by the user should be handled at the top level by a function in the relevant system/frame's `Actions` namespace. Avoid closing over or passing state from the component body to the action handler unless it's indirect state, like a store or any other variant of `ZusUtils.AnyInput`.

Pass `ZusUtils.AnyInut` instances via the `stores` prop through components(conventionally they should have a KeyProp or a StoreProp defined to standardize what property they should be put on in `props.stores`), and avoid using react context to pass stores or other data sources.
