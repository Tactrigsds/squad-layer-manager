export type SetStateCallback<T> = (prevState: T) => T
export type SetState<T> = (cb: SetStateCallback<T>) => void
