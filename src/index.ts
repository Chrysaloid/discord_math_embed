/**
discord_math_embed - a Cloudflare Worker that evaluates a math expression from the URL and
returns it as Open Graph meta tags, so a link pasted into Discord shows the result in its
embed.

   https://<worker>.workers.dev/embed?expression=2%2B2   ->  embed titled "2+2 = 4"

   https://<worker>.workers.dev/embed?expression=1%2F3&decimals=2   ->  "1/3 = 0.33"

   https://<worker>.workers.dev/embed?expression=1000%2F3&decimals=2e   ->  "1000/3 = 3.33e2"

`expr` works as a shorter alias of `expression`. The optional `decimals` (a whole number, 0 to
100) rounds the result to that many digits after the decimal point, like Number.toFixed; with an
"e" before or after the number, or a lone "e", it shows the result in compact scientific notation
(src/build_embed.ts's header has the details). Without it the result shows up to 14 significant
digits. The expression is evaluated by math.js
(https://mathjs.org/docs/expressions/syntax.html): operators, functions (sqrt, sin, log,
factorial, ...), constants (pi, e), units (`5 cm to inch`), matrices, several expressions
separated by `;` (the last one is the result). src/build_embed.ts does that, with the functions
that could reach outside one evaluation disabled.

/embed is the only path the Worker answers; every other one redirects there, except the files of
dist/ (the creator's script), which Cloudflare serves as static assets without running the Worker.
The /embed page (src/embed.html, imported minified from build/embed.html, which `npm run build`
makes before wrangler bundles) is two things at once. Discord builds the embed from the Open
Graph tags in its <head> (no JavaScript runs there), so the expression is evaluated and rendered
here. A browser shows the embed creator, filled in with the URL's expression: it previews the
embed of a typed expression and gives the masked link to paste on Discord, all in the browser
(src/creator.ts), with no request per keystroke. So the embed's title, a link to its own URL,
opens the creator. Without an expression the page's tags describe the creator itself.
*/
import { build_embed, type Embed, EMBED_COLOR, SITE_NAME } from "./build_embed";
import embed_page_template from "../build/embed.html";

//* Settings
const EMBED_PATH = "/embed";
const CREATOR_EMBED: Embed = {
	title: "Create your own embedded math",
	description: "Type an expression, copy the link, paste it on Discord.",
	color: EMBED_COLOR,
};
const CACHE_CONTROL = "public, max-age=86400";

//* The page
const HTML_ESCAPES: Readonly<Record<string, string>> = {
	"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};
function escape_html(text: string): string {
	return text.replace(/[&<>"']/g, character => HTML_ESCAPES[character] ?? character);
}
/** The embed page (src/embed.html, minified) with the <title> and Open Graph tags that carry `embed` into the
 * Discord embed in place of its embed_meta comment. */
function embed_page({ title, description, color }: Embed): Response {
	const meta = [
		`<title>${escape_html(title)}</title>`,
		`<meta property="og:site_name" content="${escape_html(SITE_NAME)}">`,
		`<meta property="og:title" content="${escape_html(title)}">`,
		...description === "" ? [] : [`<meta property="og:description" content="${escape_html(description)}">`],
		`<meta name="theme-color" content="${color}">`,
	].join("");  // no whitespace, like the minified page around them
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
				return embed_page(build_embed(expression.trim(), url.searchParams.get("decimals")));
			}
		}
		return Response.redirect(url.origin + EMBED_PATH + url.search, 302);
	},
} satisfies ExportedHandler<Env>;
