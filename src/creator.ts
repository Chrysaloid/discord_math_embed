/**
The embed creator of the /embed page (src/embed.html): type an expression, and the decimals to round
its result to if any, see the Discord embed it gives, copy the markdown masked link to paste on
Discord. Both go into the page's URL and the link, as `expression` and `decimals`. Everything runs in the browser: the embed
comes from src/build_embed.ts, the same code the Worker puts into the Open Graph tags, so the
preview is what Discord gets and typing makes no requests.

`npm run build` bundles this file with build_embed.ts and math.js into dist/creator.js, which
Cloudflare serves as a static asset; wrangler runs that build itself before `wrangler dev` and
`wrangler deploy` (wrangler.toml's [build]). It is type-checked with the DOM types by
tsconfig.creator.json, as the Worker's tsconfig.json has no DOM.
*/
import { build_embed, type Embed, SITE_NAME } from "./build_embed";

//* Settings
const DEFAULT_EXPRESSION = "2+2";
const COPIED_LABEL_MS = 1500;
const WORKER_CPU_LIMIT_MS = 10;  // per request on Cloudflare's free plan

//* Page elements
function element<T extends HTMLElement>(id: string): T {
	const found = document.getElementById(id);
	if (found === null) throw new Error(`The page has no #${id}`);
	return found as T;
}
const expression_input = element<HTMLInputElement>("expression");
const decimals_input = element<HTMLInputElement>("decimals");
const status_line = element("status");
const message_link = element<HTMLAnchorElement>("message_link");
const embed_box = element("embed");
const embed_provider = element("embed_provider");
const embed_title = element<HTMLAnchorElement>("embed_title");
const embed_description = element("embed_description");
const markdown = element("markdown");
const copy_button = element<HTMLButtonElement>("copy");

//* Building the link
/** encodeURIComponent leaves ! ' ( ) * as they are, and a ")" would end Discord's masked link early. */
function encode_query_value(text: string): string {
	return encodeURIComponent(text).replace(/[!'()*]/g, character => "%" + character.charCodeAt(0).toString(16).toUpperCase());
}
/** The URL's query: the expression, and the decimals unless they are blank. */
function embed_query(expression: string, decimals: string): string {
	const query = `?expression=${encode_query_value(expression)}`;
	return decimals.trim() === "" ? query : `${query}&decimals=${encode_query_value(decimals)}`;
}
/** Backslash-escapes what Discord's markdown would otherwise format inside the link text. */
function escape_discord_markdown(text: string): string {
	return text.replace(/[\\*_~`|[\]<>:@#]/g, "\\$&");
}
//* Showing an embed
function show_embed(query: string, { title, description, color }: Embed): void {
	const url = `${location.origin}/embed${query}`;
	document.title = title;  // as the Worker's <title> would be for this expression
	embed_provider.textContent = SITE_NAME;
	message_link.textContent = title;
	message_link.href = url;
	embed_title.textContent = title;
	embed_title.href = url;
	embed_description.textContent = description;
	embed_box.style.setProperty("--embed_color", color);
	markdown.textContent = `[${escape_discord_markdown(title)}](${url})`;
	copy_button.disabled = false;
}
function show_nothing(): void {
	embed_provider.textContent = "";
	message_link.textContent = "";
	embed_title.textContent = "";
	embed_description.textContent = "";
	embed_box.style.removeProperty("--embed_color");
	markdown.textContent = "";
	copy_button.disabled = true;
}
/** Shows the typed expression's embed, rounded to the typed decimals, and puts both into the page's
 * URL. An expression that took longer than the Worker's CPU limit here gets a warning, as Discord
 * may get no embed. */
function update(): void {
	const expression = expression_input.value;
	const decimals = decimals_input.value;
	const query = embed_query(expression, decimals);
	history.replaceState(null, "", expression === "" ? location.pathname : query);
	if (expression.trim() === "") {
		show_nothing();
		status_line.textContent = "Type an expression.";
		return;
	}
	const start = performance.now();
	const embed = build_embed(expression, decimals);
	const elapsed_ms = performance.now() - start;
	show_embed(query, embed);
	status_line.textContent = elapsed_ms <= WORKER_CPU_LIMIT_MS ? "" :
		`This took ${Math.round(elapsed_ms)} ms to evaluate here. The server gets ${WORKER_CPU_LIMIT_MS} ms, so Discord may show no embed for it.`;
}
//* Events
expression_input.addEventListener("input", update);
decimals_input.addEventListener("input", update);
copy_button.addEventListener("click", async () => {
	await navigator.clipboard.writeText(markdown.textContent);
	copy_button.textContent = "Copied";
	setTimeout(() => { copy_button.textContent = "Copy" }, COPIED_LABEL_MS);
});
//* Start
build_embed("1+1");  // warms math.js up, so the first timed evaluation is not slowed by it
const url_parameters = new URLSearchParams(location.search);
const url_expression = url_parameters.get("expression") ?? url_parameters.get("expr") ?? "";
expression_input.value = url_expression.trim() === "" ? DEFAULT_EXPRESSION : url_expression;
decimals_input.value = url_parameters.get("decimals") ?? "";
update();
