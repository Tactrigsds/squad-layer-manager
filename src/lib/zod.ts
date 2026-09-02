// zod, with the JIT compiler installed. A module's imports evaluate before its body, so importing `z` from
// here is what puts the compiler in place before any schema is constructed: there is no entry point to
// remember. Bare 'zod' survives in plugins/, where the specifier is part of the API contract.
import 'zod/compile'

export * from 'zod'
// `export *` skips the default, and the plugin API republishes this namespace verbatim.
export { default } from 'zod'
