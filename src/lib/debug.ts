export function log<T>(param: T, key?: string) {
	if (key) {
		console.log(key, param)
	} else {
		console.log(param)
	}
	return param
}
