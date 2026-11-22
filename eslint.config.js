//* ESLint: the shared config of "1. Mój Folder", with this file parsed as an ES module
// The shared config lints .ts with the typescript-eslint parser and parses every .js as a script, but
// package.json here says "type": "module", so this file's own `import`/`export` would be a parsing error.
import shared_config from "../../../eslint.config.js";

export default [
	{
		ignores: [".wrangler/", "dist/", "worker-configuration.d.ts"],
	},
	...shared_config,
	{
		files: ["**/*.js"],
		languageOptions: {
			sourceType: "module",
		},
	},
];
