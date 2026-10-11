// tanstack-form surfaces standard-schema issues, so a field error is an object rather than a string. Rendering
// one directly yields "[object Object]".
export function formatFieldErrors(errors: unknown[]) {
	return errors
		.map((err) => {
			if (typeof err === 'string') return err
			if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message)
			return String(err)
		})
		.join(', ')
}
