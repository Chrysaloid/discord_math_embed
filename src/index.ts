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

/embed is the only path; every other one redirects there. Its page (src/embed.html) is two
things at once. Discord builds the embed from the Open Graph tags in its <head> (no JavaScript
runs there), so the expression is evaluated and rendered here. A browser shows the embed
creator, filled in with the URL's expression: it previews the embed of a typed expression and
gives the masked link to paste on Discord. So the embed's title, a link to its own URL, opens
the creator. Without an expression the page's tags describe the creator itself.
*/
import { all, create } from "mathjs";
import embed_page_template from "./embed.html";

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
const SITE_NAME = "Math embed";  // the embed's top line
const EMBED_PATH = "/embed";
const CREATOR_EMBED: Embed = {
	title: "Create your own embedded math",
	description: "Type an expression, copy the link, paste it on Discord.",
	color: EMBED_COLOR,
};
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
/** The embed page (src/embed.html) with the <title> and Open Graph tags that carry `embed` into the
 * Discord embed in place of its embed_meta comment. */
function embed_page({ title, description, color }: Embed): Response {
	const meta = [
		`<title>${escape_html(title)}</title>`,
		`<meta property="og:site_name" content="${escape_html(SITE_NAME)}">`,
		`<meta property="og:title" content="${escape_html(title)}">`,
		...description === "" ? [] : [`<meta property="og:description" content="${escape_html(description)}">`],
		`<meta name="theme-color" content="${color}">`,
	].join("\n");
	// A function as the replacement, so a "$&" in the expression stays as it is
	const page = embed_page_template.replace("<!--embed_meta-->", () => meta);
	return new Response(page, {
		headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": CACHE_CONTROL },
	});
}

//* Worker entry point
export default {
	fetch(request: Request): Response {
		const url = new URL(request.url);
		switch (url.pathname) {
			case EMBED_PATH: {
				const expression = url.searchParams.get("expression") ?? url.searchParams.get("expr");
				if (expression === null || expression.trim() === "") return embed_page(CREATOR_EMBED);
				return embed_page(build_embed(expression));
			}
		}
		return Response.redirect(url.origin + EMBED_PATH + url.search, 302);
	},
} satisfies ExportedHandler<Env>;
