//* ESLint: the shared config of "1. Mój Folder", with this project's .js files parsed as ES modules
// The shared config parses every .js as a script, but package.json here says "type": "module"
// (a Cloudflare Worker is an ES module), so `import`/`export` would be a parsing error.
import shared_config from "../../../eslint.config.js";

export default [
	{
		ignores: [".wrangler/"],
	},
	...shared_config,
	{
		files: ["**/*.js"],
		languageOptions: {
			sourceType: "module",
		},
	},
];
