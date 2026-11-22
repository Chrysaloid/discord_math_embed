/**
discord_math_embed - a Cloudflare Worker that evaluates a math expression from the URL and
returns it as Open Graph meta tags, so a link pasted into Discord shows the result in its
embed.

   https://<worker>.workers.dev/embed?expression=2%2B2   ->  embed titled "2+2 = 4"

`expr` works as a shorter alias of `expression`. The expression is evaluated by math.js
(https://mathjs.org/docs/expressions/syntax.html): operators, functions (sqrt, sin, log,
factorial, ...), constants (pi, e), units (`5 cm to inch`), matrices, several expressions
separated by `;` (the last one is the result). The functions that could reach outside a
single evaluation (import, createUnit, evaluate, parse, ...) are disabled, following
https://mathjs.org/docs/expressions/security.html.

Every other path answers with a short usage page. Discord builds the embed from the HTML
the server sends (no JavaScript runs), so everything is rendered here.
*/
import { all, create } from "mathjs";

//* math.js with the dangerous functions disabled
// math.js declares `all` as one entry of a Record, so noUncheckedIndexedAccess adds `| undefined`
const math = create(all!);
const limited_evaluate = math.evaluate;
function disabled(name: string): () => never {
	return () => { throw new Error(`Function ${name} is disabled`) };
}
math.import(Object.fromEntries(
	["import", "createUnit", "reviver", "evaluate", "parse", "simplify", "derivative", "resolve", "compile"]
	.map(name => [name, disabled(name)])
), { override: true });

//* Settings
const MAX_EXPRESSION_LENGTH = 500;
const MAX_RESULT_LENGTH = 1000;
const MAX_TITLE_LENGTH = 256;  // Discord's embed title limit
const RESULT_PRECISION = 14;
const EMBED_COLOR = "#5865F2";
const SITE_NAME = "Math embed";

//* Helpers
const HTML_ESCAPES: Readonly<Record<string, string>> = {
	"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};
function escape_html(text: string): string {
	return text.replace(/[&<>"']/g, character => HTML_ESCAPES[character] ?? character);
}
function truncate(text: string, max_length: number): string {
	return text.length <= max_length ? text : text.slice(0, max_length - 1) + "…";
}
type Evaluation = { result: string } | { error: string };
/** Evaluates `expression`; returns `{ result }` or `{ error }`, never throws. */
function evaluate_expression(expression: string): Evaluation {
	if (expression.length > MAX_EXPRESSION_LENGTH) {
		return { error: `Expression longer than ${MAX_EXPRESSION_LENGTH} characters` };
	}
	try {
		let value: unknown = limited_evaluate(expression);
		if (math.isResultSet(value)) value = value.entries.at(-1);
		if (value === undefined) return { error: "The expression has no result" };
		if (typeof value === "function") return { error: "The result is a function" };
		return { result: truncate(math.format(value, { precision: RESULT_PRECISION }), MAX_RESULT_LENGTH) };
	} catch (exception) {
		return { error: exception instanceof Error ? exception.message : String(exception) };
	}
}
/** A page whose Open Graph tags carry `title` and `description` (left out when empty) into the
 * Discord embed, with `color` as the embed's side bar. */
function html_page(title: string, description = "", color = EMBED_COLOR): Response {
	const description_meta = description === "" ? "" : `<meta property="og:description" content="${escape_html(description)}">\n`;
	const page = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escape_html(title)}</title>
<meta property="og:site_name" content="${escape_html(SITE_NAME)}">
<meta property="og:title" content="${escape_html(title)}">
${description_meta}<meta name="theme-color" content="${color}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body { font-family: system-ui, sans-serif; max-width: 40em; margin: 3em auto; padding: 0 1em; }
h1 { font-size: 2em; word-break: break-word; text-align: center }
</style>
</head>
<body>
<h1>${escape_html(title)}</h1>
<p>${escape_html(description)}</p>
</body>
</html>
`;
	return new Response(page, {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "public, max-age=86400",
		},
	});
}

//* Worker entry point
export default {
	fetch(request: Request): Response {
		const url = new URL(request.url);
		const expression = url.searchParams.get("expression") ?? url.searchParams.get("expr");
		if (url.pathname !== "/embed" || expression === null || expression.trim() === "") {
			return html_page(SITE_NAME, `Usage: ${url.origin}/embed?expression=2%2B2`);
		}
		const evaluation = evaluate_expression(expression);
		if ("error" in evaluation) return html_page(`${truncate(expression, 200)} → error`, evaluation.error, "#ED4245");
		// A result too long for the title goes whole into the description, which allows 4096
		const title = `${truncate(expression, 200)} = ${evaluation.result}`;
		if (title.length <= MAX_TITLE_LENGTH) return html_page(title);
		return html_page(truncate(title, MAX_TITLE_LENGTH), evaluation.result);
	},
} satisfies ExportedHandler<Env>;
