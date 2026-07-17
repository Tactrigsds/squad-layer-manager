export function maxLength(length: number) {
	return `Must be at most ${length} characters long`
}

// tanstack-form surfaces standard-schema issues, so a field error is an object rather than the plain
// string it used to be. Rendering one directly yields "[object Object]".
export function formatFieldErrors(errors: unknown[]) {
	return errors
		.map(err => {
			if (typeof err === 'string') return err
			if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message)
			return String(err)
		})
		.join(', ')
}
