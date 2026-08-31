import * as Icons from 'lucide-react'

/**
 * The icon set the app itself draws from, as one namespace rather than 5000 named exports: the generated
 * shim declares a binding per export, and lucide has enough of them to make that the largest module on the
 * page.
 *
 * A plugin must not import `lucide-react` directly. It is not in the host's import map, so the bundle loads
 * and then fails to resolve, which takes the plugin's whole client half down with nothing in the server log.
 */
export { Icons }
