/**
What the Discord embed of an expression shows - shared by the Worker (src/index.ts), which puts it
into the page's Open Graph tags, and the creator in the browser (src/creator.ts, bundled with this
module and math.js into dist/creator.js), which previews it. Both run this same code with the same
math.js, so the preview is what Discord gets. It must therefore use nothing that only one of the two
environments has.

The expression is evaluated by math.js (https://mathjs.org/docs/expressions/syntax.html). The
functions that could reach outside a single evaluation (import, createUnit, evaluate, parse, ...)
are disabled, following https://mathjs.org/docs/expressions/security.html.

The result shows up to 14 significant digits, or, given `decimals` (the URL's `decimals` parameter),
exactly that many digits after the decimal point, like Number.toFixed: math.js's "fixed" notation,
which rounds in decimal (1.005 -> 1.01, where toFixed gives 1.00), never switches to an exponent and
applies to every number inside a unit, a complex number or a matrix as well.
*/
import { all, create, type FormatOptions } from "mathjs";

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
const MAX_DECIMALS = 100;  // as Number.toFixed allows
export const EMBED_COLOR = "#5865F2";
const ERROR_COLOR = "#ED4245";
export const SITE_NAME = "Math embed";  // the embed's top line

//* Evaluation
function truncate(text: string, max_length: number): string {
	return text.length <= max_length ? text : text.slice(0, max_length - 1) + "…";
}
type Evaluation = { result: string } | { error: string };
const WHOLE_NUMBER = /^\s*\d+\s*$/;
/** The format options of `decimals`: the URL's text of a whole number from 0 to MAX_DECIMALS, or
 * null or blank for RESULT_PRECISION significant digits; a string for anything else, the error. */
function format_options(decimals: string | null): FormatOptions | string {
	if (decimals === null || decimals.trim() === "") return { precision: RESULT_PRECISION };
	const count = Number(decimals);
	if (!WHOLE_NUMBER.test(decimals) || count > MAX_DECIMALS) {
		return `Decimals must be a whole number from 0 to ${MAX_DECIMALS}`;
	}
	return { notation: "fixed", precision: count };
}
/** Evaluates `expression` and formats the result by `decimals` (see format_options); returns
 * `{ result }` or `{ error }`, never throws. */
function evaluate_expression(expression: string, decimals: string | null): Evaluation {
	if (expression.length > MAX_EXPRESSION_LENGTH) {
		return { error: `Expression longer than ${MAX_EXPRESSION_LENGTH} characters` };
	}
	const options = format_options(decimals);
	if (typeof options === "string") return { error: options };
	try {
		let value: unknown = limited_evaluate(expression);
		if (math.isResultSet(value)) value = value.entries.at(-1);
		if (value === undefined) return { error: "The expression has no result" };
		if (typeof value === "function") return { error: "The result is a function" };
		return { result: truncate(math.format(value, options), MAX_RESULT_LENGTH) };
	} catch (exception) {
		return { error: exception instanceof Error ? exception.message : String(exception) };
	}
}
/** What the Discord embed shows: `description` is left out of the page when empty, `color` is the
 * embed's side bar. */
export type Embed = { title: string; description: string; color: string };
/** The embed of `expression`, its result rounded to `decimals` digits after the point when given (see
 * format_options): "expression = result", or "expression → error" with the error message as the
 * description. */
export function build_embed(expression: string, decimals: string | null = null): Embed {
	const evaluation = evaluate_expression(expression, decimals);
	if ("error" in evaluation) {
		return { title: `${truncate(expression, 200)} → error`, description: evaluation.error, color: ERROR_COLOR };
	}
	// A result too long for the title goes whole into the description, which allows 4096
	const title = `${truncate(expression, 200)} = ${evaluation.result}`;
	if (title.length <= MAX_TITLE_LENGTH) return { title, description: "", color: EMBED_COLOR };
	return { title: truncate(title, MAX_TITLE_LENGTH), description: evaluation.result, color: EMBED_COLOR };
}
