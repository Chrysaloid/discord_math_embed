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

Paths:
   /embed?expression=...       the embed page; Discord builds the embed from its HTML (no
                               JavaScript runs there), so everything is rendered here
   /create_embed               a page that previews the embed of a typed expression and gives
                               the masked link to paste on Discord (src/create_embed.html)
   /api/embed?expression=...   the embed as JSON, { title, description, color }, for that page
   /oembed                     the oEmbed JSON every embed page links to; it makes the embed's
                               top line "Math embed · Create your own", a link to /create_embed
                               (Open Graph has no way to give that line a link)
Every other path answers with a short usage page.
*/
import { all, create } from "mathjs";
import create_embed_page from "./create_embed.html";

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
const ERROR_COLOR = "#ED4245";
const SITE_NAME = "Math embed";
const PROVIDER_NAME = `${SITE_NAME} · Create your own`;  // the embed's top line
const CREATE_EMBED_PATH = "/create_embed";
const CACHE_CONTROL = "public, max-age=86400";

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
/** What the Discord embed shows: `description` is left out of the page when empty, `color` is the
 * embed's side bar. */
type Embed = { title: string; description: string; color: string };
/** The embed of `expression`: "expression = result", or "expression → error" with the error message
 * as the description. */
function build_embed(expression: string): Embed {
	const evaluation = evaluate_expression(expression);
	if ("error" in evaluation) {
		return { title: `${truncate(expression, 200)} → error`, description: evaluation.error, color: ERROR_COLOR };
	}
	// A result too long for the title goes whole into the description, which allows 4096
	const title = `${truncate(expression, 200)} = ${evaluation.result}`;
	if (title.length <= MAX_TITLE_LENGTH) return { title, description: "", color: EMBED_COLOR };
	return { title: truncate(title, MAX_TITLE_LENGTH), description: evaluation.result, color: EMBED_COLOR };
}
function html_response(page: string): Response {
	return new Response(page, {
		headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": CACHE_CONTROL },
	});
}
function json_response(value: unknown): Response {
	return new Response(JSON.stringify(value), {
		headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": CACHE_CONTROL },
	});
}
/** A page whose Open Graph tags carry `embed` into the Discord embed. It links the oEmbed JSON at
 * `origin`/oembed, which gives the embed its top line. */
function html_page(origin: string, { title, description, color }: Embed): Response {
	const description_meta = description === "" ? "" : `<meta property="og:description" content="${escape_html(description)}">\n`;
	return html_response(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escape_html(title)}</title>
<meta property="og:site_name" content="${escape_html(PROVIDER_NAME)}">
<meta property="og:title" content="${escape_html(title)}">
${description_meta}<meta name="theme-color" content="${color}">
<link rel="alternate" type="application/json+oembed" href="${escape_html(origin)}/oembed">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body { font-family: system-ui, sans-serif; max-width: 40em; margin: 3em auto; padding: 0 1em; }
h1 { font-size: 2em; word-break: break-word; text-align: center }
</style>
</head>
<body>
<h1>${escape_html(title)}</h1>
<p>${escape_html(description)}</p>
<p><a href="${CREATE_EMBED_PATH}">Create your own</a></p>
</body>
</html>
`);
}

//* Worker entry point
export default {
	fetch(request: Request): Response {
		const url = new URL(request.url);
		const expression = url.searchParams.get("expression") ?? url.searchParams.get("expr");
		const has_expression = expression !== null && expression.trim() !== "";
		switch (url.pathname) {
			case CREATE_EMBED_PATH:
				return html_response(create_embed_page);
			case "/oembed":
				// Discord shows provider_name as the embed's top line, a link to provider_url
				return json_response({
					version: "1.0",
					type: "link",
					provider_name: PROVIDER_NAME,
					provider_url: url.origin + CREATE_EMBED_PATH,
				});
			case "/api/embed":
				if (!has_expression) return new Response("Missing ?expression=", { status: 400 });
				return json_response(build_embed(expression));
			case "/embed":
				if (has_expression) return html_page(url.origin, build_embed(expression));
		}
		return html_page(url.origin, {
			title: SITE_NAME,
			description: `Usage: ${url.origin}/embed?expression=2%2B2, or create one at ${url.origin}${CREATE_EMBED_PATH}`,
			color: EMBED_COLOR,
		});
	},
} satisfies ExportedHandler<Env>;
