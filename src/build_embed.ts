/**
What the Discord embed of an expression shows - shared by the Worker (src/index.ts), which puts it
into the page's Open Graph tags, and the creator in the browser (src/creator.ts, bundled with this
module and math.js into dist/creator.js), which previews it. Both run this same code with the same
math.js, so the preview is what Discord gets. It must therefore use nothing that only one of the two
environments has.

The expression is evaluated by math.js (https://mathjs.org/docs/expressions/syntax.html). The
functions that could reach outside a single evaluation (import, createUnit, evaluate, parse, ...)
are disabled, following https://mathjs.org/docs/expressions/security.html.
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
export const EMBED_COLOR = "#5865F2";
const ERROR_COLOR = "#ED4245";
export const SITE_NAME = "Math embed";  // the embed's top line

//* Evaluation
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
export type Embed = { title: string; description: string; color: string };
/** The embed of `expression`: "expression = result", or "expression → error" with the error message
 * as the description. */
export function build_embed(expression: string): Embed {
	const evaluation = evaluate_expression(expression);
	if ("error" in evaluation) {
		return { title: `${truncate(expression, 200)} → error`, description: evaluation.error, color: ERROR_COLOR };
	}
	// A result too long for the title goes whole into the description, which allows 4096
	const title = `${truncate(expression, 200)} = ${evaluation.result}`;
	if (title.length <= MAX_TITLE_LENGTH) return { title, description: "", color: EMBED_COLOR };
	return { title: truncate(title, MAX_TITLE_LENGTH), description: evaluation.result, color: EMBED_COLOR };
}
