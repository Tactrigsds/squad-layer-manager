/** @type {import("prettier").Config} */
const config = {
	parser: 'babel-ts',
	trailingComma: 'es5',
	useTabs: true,
	semi: false,
	singleQuote: true,
	printWidth: 140,
	plugins: ['@babel/plugin-proposal-explicit-resource-management', 'prettier-plugin-tailwindcss', '@trivago/prettier-plugin-sort-imports'],
	importOrder: ['<THIRD_PARTY_MODULES>', '^@/(.*)$', '^[./]'],
	importOrderSeparation: true,
	importOrderSortSpecifiers: true,
}

export default config
