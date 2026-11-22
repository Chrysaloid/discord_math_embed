/*
profile_fetch_node.mjs - how many milliseconds the Worker's fetch() takes, and where they go, with
the Worker's code run in Node.

workerd cannot time it: Workers freeze performance.now() while code runs, and workerd's sampler on
Windows takes about one sample per 15 ms (profile_fetch.py, which profiles the real runtime, gives
shares only for that reason). Node has neither problem, so this bundles src/index.ts with esbuild the
way wrangler does (the .html as text, the workerd/worker/browser package conditions; the page
minified first by `npm run build:page`) into
profiles/node_bundle/, imports it, and calls its fetch() in a loop - no server, no HTTP:
   - the first call alone (math.js builds each function on first use, V8 has optimized nothing yet),
   - --warm_up calls unmeasured,
   - --requests calls, each timed with performance.now(), with Node's CPU profiler running.
The Request is made before the timer starts; the Response body is not read.

Printed, for each expression: fetch's time per call (mean, median, p90, p99, min, max), and the
functions inside fetch by total and self time - their share of fetch's samples times the measured
mean, so in milliseconds per call. Files and lines are those of src/ and node_modules/, mapped back
through the bundle's source map (node:module's SourceMap). Saved: profiles/<timestamp>_node_
<expression>.cpuprofile, source-mapped, with its real sample times; --flame opens it in speedscope.

Node is not workerd: its V8 is another version, and its Request, Response and URL are Node's own
(workerd's are C++), so the math.js and src/ parts carry over best. Cloudflare's machines differ
from this PC too.

   node profile_fetch_node.mjs                         # F5 works
   node profile_fetch_node.mjs "factorial(170)" -n 50000 --flame
esbuild is the global npm install (found through NODE_PATH), and so is speedscope; f5_argv comes
from my JavaScript my_libs (Informatyka\JavaScript\my_libs, on NODE_PATH too).
*/
import { createRequire, SourceMap } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import { parseArgs } from "node:util";
import path from "node:path";
import { Session } from "node:inspector/promises";
import { spawnSync } from "node:child_process";
import v8 from "node:v8";
// NODE_PATH serves require() only: it finds my JavaScript my_libs and the global npm packages (esbuild)
const require = createRequire(import.meta.url);
const { f5_argv } = require("my_libs/was_run_by_code_runner");

const F5_ARGS = String.raw``;

const DEFAULT_EXPRESSIONS = ["2+2", "5 cm to inch", "sqrt(2)*[1,2]"];
const PROJECT_FOLDER = path.dirname(fileURLToPath(import.meta.url));
const PROFILES_FOLDER = path.join(PROJECT_FOLDER, "profiles");
const BUNDLE_PATH = path.join(PROFILES_FOLDER, "node_bundle", "index.mjs");
const WORKER_SOURCE = path.join(PROJECT_FOLDER, "src", "index.ts");
const USAGE = `usage: node profile_fetch_node.mjs [expression ...] [-n requests] [--warm_up n] [--interval µs] [--top rows] [--flame]
  defaults: ${DEFAULT_EXPRESSIONS.join("  ")}, -n 20000, --warm_up 2000, --interval 100, --top 20`;

/** The options, or null when the arguments are wrong or ask for help (the usage is printed then). */
function parse_arguments() {
	let parsed;
	try {
		parsed = parseArgs({
			args: f5_argv(F5_ARGS),
			allowPositionals: true,
			options: {
				requests: { type: "string", short: "n", default: "20000" },
				warm_up: { type: "string", default: "2000" },
				interval: { type: "string", default: "100" },
				top: { type: "string", default: "20" },
				flame: { type: "boolean", default: false },
				help: { type: "boolean", short: "h", default: false },
			},
		});
	} catch (error) {
		console.error(`${error.message}\n${USAGE}`);
		process.exitCode = 2;
		return null;
	}
	const { values, positionals } = parsed;
	if (values.help) {
		console.log(USAGE);
		return null;
	}
	return {
		expressions: positionals.length ? positionals : DEFAULT_EXPRESSIONS,
		requests: Number(values.requests),
		warm_up: Number(values.warm_up),
		interval: Number(values.interval),
		top: Number(values.top),
		flame: values.flame,
	};
}
//* The Worker, bundled as wrangler bundles it
async function load_worker() {
	// src/index.ts imports the minified page, build/embed.html, which wrangler's [build] makes otherwise
	const page_build = spawnSync("npm run build:page", { cwd: PROJECT_FOLDER, stdio: "inherit", shell: true });
	if (page_build.status !== 0) throw new Error("npm run build:page failed");
	const esbuild = require("esbuild");
	await esbuild.build({
		entryPoints: [WORKER_SOURCE],
		outfile: BUNDLE_PATH,
		bundle: true,
		format: "esm",
		platform: "browser",
		conditions: ["workerd", "worker", "browser"],
		target: "es2022",
		loader: { ".html": "text" },
		sourcemap: true,
		logLevel: "warning",
	});
	const worker = (await import(pathToFileURL(BUNDLE_PATH).href)).default;
	const source_map = new SourceMap(JSON.parse(fs.readFileSync(BUNDLE_PATH + ".map", "utf8")));
	return { worker, source_map };
}
/** The source file, 1-based line and column of a 0-based position in the bundle, or null. */
function map_position(source_map, line, column) {
	const entry = source_map.findEntry(line, column);
	if (!entry?.originalSource) return null;
	const source_path = entry.originalSource.startsWith("file:") ?
		fileURLToPath(entry.originalSource) :
		path.resolve(path.dirname(BUNDLE_PATH), entry.originalSource);
	return { path: source_path, line: entry.originalLine + 1, column: entry.originalColumn + 1 };
}
function display_path(file_path) {
	const parts = file_path.split(path.sep);
	const node_modules = parts.lastIndexOf("node_modules");
	if (node_modules >= 0) return parts.slice(node_modules + 1).join("/");
	return path.relative(PROJECT_FOLDER, file_path).split(path.sep).join("/");
}
//* Measuring
/** Times one fetch() call. Kept out of V8's optimizing compilers: optimized, it inlined fetch() into the
 * measuring loop, and fetch() vanished from the profile's stacks. Unoptimized code inlines nothing, and
 * fetch() and everything it calls are still optimized as usual. */
function call_fetch(worker, request) {
	const start = performance.now();
	worker.fetch(request);
	return performance.now() - start;
}
v8.setFlagsFromString("--allow-natives-syntax");
// eslint-disable-next-line no-new-func -- the only way to reach a V8 intrinsic once the flag is set at run time
new Function("call_fetch", "%NeverOptimizeFunction(call_fetch)")(call_fetch);
async function measure(worker, expression, options) {
	const url = `http://127.0.0.1/embed?expression=${encodeURIComponent(expression)}`;
	const time_call = () => call_fetch(worker, new Request(url));
	const first_ms = time_call();
	for (let index = 0; index < options.warm_up; index++) time_call();
	const session = new Session();
	session.connect();
	await session.post("Profiler.enable");
	await session.post("Profiler.setSamplingInterval", { interval: options.interval });
	await session.post("Profiler.start");
	const durations = new Float64Array(options.requests);
	for (let index = 0; index < options.requests; index++) durations[index] = time_call();
	const { profile } = await session.post("Profiler.stop");
	session.disconnect();
	return { first_ms, durations: durations.sort(), profile };
}
//* Analysis
/** Self and total samples inside the Worker's fetch, by function, and how many samples fell inside it. */
function analyze(profile, source_map) {
	const frames = new Map();
	const parents = new Map();
	const bundle_url = pathToFileURL(BUNDLE_PATH).href;
	for (const node of profile.nodes) {
		const { functionName, url, lineNumber, columnNumber } = node.callFrame;
		const location = url === bundle_url ? map_position(source_map, lineNumber, columnNumber) : null;
		const name = functionName || "(anonymous)";
		const place = location ? `${display_path(location.path)}:${location.line}` : (url && !url.startsWith("node:") ? url : "");
		frames.set(node.id, { key: `${name}  ${place}`.trim(), is_fetch: name === "fetch" && location?.path === WORKER_SOURCE });
		for (const child of node.children ?? []) parents.set(child, node.id);
	}
	const self = new Map();
	const total = new Map();
	let fetch_samples = 0;
	for (const node_id of profile.samples) {
		const stack = [node_id];  // leaf first
		while (parents.has(stack.at(-1))) stack.push(parents.get(stack.at(-1)));
		const fetch_index = stack.findIndex(stack_id => frames.get(stack_id).is_fetch);
		if (fetch_index < 0) continue;
		fetch_samples++;
		const leaf = frames.get(node_id).key;
		self.set(leaf, (self.get(leaf) ?? 0) + 1);
		for (const key of new Set(stack.slice(0, fetch_index + 1).map(stack_id => frames.get(stack_id).key))) {
			total.set(key, (total.get(key) ?? 0) + 1);
		}
	}
	return { self, total, fetch_samples };
}
//* Report
function percentile(sorted, fraction) {
	return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
}
function ms(value) {
	return `${value.toFixed(4).padStart(8)} ms`;
}
function print_report(expression, { first_ms, durations }, { self, total, fetch_samples }, options, is_first) {
	const mean = durations.reduce((sum, value) => sum + value, 0) / durations.length;
	console.log(`\n#* ${expression}  (${options.requests} calls after ${options.warm_up} unmeasured)`);
	console.log(`   fetch() per call: mean ${ms(mean).trim()}, median ${ms(percentile(durations, 0.5)).trim()},` +
		` p90 ${ms(percentile(durations, 0.9)).trim()}, p99 ${ms(percentile(durations, 0.99)).trim()},` +
		` min ${ms(durations[0]).trim()}, max ${ms(durations.at(-1)).trim()}`);
	console.log(`   its first call: ${ms(first_ms).trim()}` + (is_first ?
		" (cold: the run's first, nothing optimized, math.js building its functions)" :
		" (after the expressions before it, which built and optimized much of what it needs)"));
	if (fetch_samples === 0) {
		console.log("   No sample fell inside fetch() - make more calls (-n).");
		return;
	}
	console.log(`   ${fetch_samples} samples inside fetch(); a function's time is its share of them times the mean`);
	console.log(`\n   ${"Functions inside fetch(), by total time".padEnd(62)}        total per call            self per call`);
	const rows = [...total.entries()].sort((first, second) => second[1] - first[1]).slice(0, options.top);
	for (const [key, total_count] of rows) {
		const self_count = self.get(key) ?? 0;
		const column = count => `${ms(mean * count / fetch_samples)} ${(100 * count / fetch_samples).toFixed(1).padStart(5)} %`;
		console.log(`   ${key.slice(0, 62).padEnd(62)} ${column(total_count)}   ${column(self_count)}`);
	}
}
//* Saving
/** `profile` with its bundle positions pointing into src/ and node_modules/, for a viewer. */
function source_mapped(profile, source_map) {
	const bundle_url = pathToFileURL(BUNDLE_PATH).href;
	const mapped = structuredClone(profile);
	for (const node of mapped.nodes) {
		const call_frame = node.callFrame;
		if (call_frame.url !== bundle_url) continue;
		const location = map_position(source_map, call_frame.lineNumber, call_frame.columnNumber);
		if (!location) continue;
		Object.assign(call_frame, { url: pathToFileURL(location.path).href, lineNumber: location.line - 1, columnNumber: location.column - 1 });
		delete node.positionTicks;  // bundle lines, which no longer match the file
	}
	return mapped;
}
function save_profile(profile, expression) {
	const now = new Date();
	const pad = number => String(number).padStart(2, "0");
	const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
	const slug = expression.replace(/[^0-9A-Za-z]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "expression";
	const file_path = path.join(PROFILES_FOLDER, `${timestamp}_node_${slug}.cpuprofile`);
	fs.writeFileSync(file_path, JSON.stringify(profile));
	return file_path;
}
function open_flame_graph(file_path) {
	// speedscope is a global npm install; its .cmd shim needs a shell on Windows, which joins the
	// arguments as they are, so the path (with spaces) is quoted here
	const result = spawnSync(`speedscope "${file_path}"`, { stdio: "inherit", shell: true });
	if (result.status !== 0) console.log("   speedscope failed - is it installed (npm i -g speedscope)?");
}
//* Main
async function main() {
	const options = parse_arguments();
	if (options === null) return;
	const { worker, source_map } = await load_worker();
	for (const [index, expression] of options.expressions.entries()) {
		const measurement = await measure(worker, expression, options);
		print_report(expression, measurement, analyze(measurement.profile, source_map), options, index === 0);
		const file_path = save_profile(source_mapped(measurement.profile, source_map), expression);
		console.log(`\n   Saved ${display_path(file_path)}`);
		if (options.flame) open_flame_graph(file_path);
	}
}
await main();
