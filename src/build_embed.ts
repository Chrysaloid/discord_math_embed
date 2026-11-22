/**
What the Discord embed of an expression shows - shared by the Worker (src/index.ts), which puts it
into the page's Open Graph tags, and the creator in the browser (src/creator.ts, bundled with this
module and math.js into dist/creator.js), which previews it. Both run this same code with the same
math.js, so the preview is what Discord gets. It must therefore use nothing that only one of the two
environments has.

The expression is evaluated by math.js (https://mathjs.org/docs/expressions/syntax.html). The
functions that could reach outside a single evaluation (import, createUnit, evaluate, parse, ...)
are disabled, following https://mathjs.org/docs/expressions/security.html.

The result shows up to 14 significant digits; the URL's `decimals` parameter changes that, for every
number inside a unit, a complex number or a matrix as well:
- `3` - exactly 3 digits after the decimal point, like Number.toFixed(3): math.js's "fixed" notation,
  which rounds in decimal (1.005 -> 1.01, where toFixed gives 1.00) and never switches to an exponent.
- `3e` or `e3` - scientific notation rounded to 3 digits after the point, like
  Number.toExponential(3), but compact: no trailing zeros and no "+" (1000 -> 1e3, 1234.5678 ->
  1.235e3, 0.00012345 -> 1.235e-4).
- `e` - scientific notation with up to 14 significant digits, as compact.
*/
import { all, type BigNumber, create, type FormatOptions } from "mathjs";

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
const MAX_DECIMALS = 100;  // as Number.toFixed and toExponential allow
export const EMBED_COLOR = "#5865F2";
const ERROR_COLOR = "#ED4245";
export const SITE_NAME = "Math embed";  // the embed's top line

//* Evaluation
function truncate(text: string, max_length: number): string {
	return text.length <= max_length ? text : text.slice(0, max_length - 1) + "…";
}
type Evaluation = { result: string } | { error: string };
/** A count of digits, with an "e" before or after it for scientific notation, or a lone "e". */
const DECIMALS_FORMAT = /^(?:\d+|\d*e|e\d+)$/;
/** The mantissa's trailing zeros (and its point if nothing is left after it), and the exponent's "+". */
const EXPONENTIAL_PADDING = /(?:\.(\d*?))?0*e\+?(-?\d+)$/;
/** `number` in math.js's exponential notation with `precision` significant digits, made compact:
 * 1.000e+3 -> 1e3, 1.230e-4 -> 1.23e-4. */
function compact_exponential(number: number | BigNumber, precision: number): string {
	return math.format(number, { notation: "exponential", precision }).replace(EXPONENTIAL_PADDING,
		(_, fraction: string | undefined, exponent: string) => `${fraction ? "." + fraction : ""}e${exponent}`);
}
/** How `decimals`, the URL's text (case and surrounding spaces ignored), formats a result (see the
 * module docstring): math.js format options or a function that formats each number; null or blank
 * for RESULT_PRECISION significant digits; a string for text that is not a valid `decimals`, the
 * error. */
function format_options(decimals: string | null): FormatOptions | ((number: number | BigNumber) => string) | string {
	const text = decimals?.trim().toLowerCase() ?? "";
	if (text === "") return { precision: RESULT_PRECISION };
	const digits = text.replace("e", "");
	if (!DECIMALS_FORMAT.test(text) || Number(digits) > MAX_DECIMALS) {
		return `Decimals must be a whole number from 0 to ${MAX_DECIMALS}, with an "e" before or after it for scientific notation`;
	}
	if (!text.includes("e")) return { notation: "fixed", precision: Number(digits) };
	// Significant digits: the one before the point and `digits` after it
	const precision = digits === "" ? RESULT_PRECISION : Number(digits) + 1;
	return number => compact_exponential(number, precision);
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
/** The embed of `expression`, its result formatted by `decimals` when given (see the module
 * docstring): "expression = result", or "expression → error" with the error message as the
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
