export class ErrorCollection<Errs extends Error[]> extends Error {
	constructor(public errors: Errs) {
		super(errors.map(e => e.message).join('\n'))
		this.name = 'OuterError'
	}
}

export class CoalescedError<Res extends { code: string }> extends Error {
	constructor(public result: Res) {
		super(`CoalescedError: ${result.code}`)
		this.name = 'CoalescedError'
	}
}
export function withType<T>() {
	return undefined as unknown as T
}

export function withThrownErrorResults<
	InnerCallback extends (...args: any[]) => { code: string },
	ErrorResponse extends { code: string; msg?: string },
>(
	_typed: ErrorResponse,
	cb: (getErr: new(res: ErrorResponse) => unknown) => InnerCallback,
) {
	class Err extends Error {
		constructor(public result: ErrorResponse) {
			super(result.msg ?? result.code)
		}
	}
	const resCallback = (...args: Parameters<InnerCallback>) => {
		try {
			return cb(Err)(...args) as ReturnType<InnerCallback>
		} catch (error) {
			if (error instanceof Err) {
				return error.result as ErrorResponse
			}
			throw error
		}
	}
	return resCallback as unknown as InnerCallback
}
