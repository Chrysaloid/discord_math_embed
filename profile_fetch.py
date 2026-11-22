"""
profile_fetch.py - where the Worker's fetch() spends its CPU time, measured in the local
`wrangler dev` (workerd, the runtime Cloudflare runs, on the same V8).

Timing inside the Worker does not work: Workers freeze Date.now() and performance.now() while
code runs. So this connects to the V8 inspector that `wrangler dev` opens (port 9229), starts
its sampling CPU profiler, sends the expression to /embed many times over a few connections at
once, and stops it. A few requests go first, unprofiled, so math.js has already built the
functions the expression needs (it builds each on first use, as a fresh copy of the Worker on
Cloudflare does) - the profile shows the steady state.

The result is shares of fetch(), not milliseconds. workerd's sampler on this Windows PC ignores
the requested interval: measured 2026-11-22, it took about one sample per 15 ms (Windows' timer
resolution) and only while the Worker was busy - 2 samples in an idle second. The gaps between
samples are therefore not CPU time, so every sample counts as one, and a share of the samples
inside fetch() is a share of fetch's CPU time. That takes thousands of requests for a few hundred
samples; the share of a function seen in n samples is good to about +-100/sqrt(n) %. The only
milliseconds printed are the client's wall-clock time per request, HTTP included.
profile_fetch_node.mjs gives milliseconds, by running the Worker's code in Node instead.

Printed, for each expression:
   - how many samples fell inside fetch(), and where the rest went (GC, idle, workerd's own code)
   - the functions, by total share (with what they call) and self share (their own code)
   - a top-down call tree from fetch: a flame graph in text, pruned below --min_percent
   - the lines of src/ by self share
Lines and files are those of src/ and node_modules/, mapped back from wrangler's bundle through
its source map. Garbage collection is not inside fetch in a V8 profile: it is reported apart.

Saved: profiles/<timestamp>_<expression>.cpuprofile, the whole profile, source-mapped, so a
viewer shows and opens src/ files, with every sample made 1 ms long, so the viewer's widths are
sample shares (its milliseconds are sample counts). As a flame graph: `--flame` opens it in
speedscope (npm i -g speedscope), or VSCode's flame view (extension
ms-vscode.vscode-js-profile-flame), or Chrome DevTools > Performance > Load profile.

Needs the server running: run_local_server.ps1 starts it.

   python profile_fetch.py                       # the default expressions, 4000 requests each
   python profile_fetch.py "factorial(170)" -n 10000 --flame
"""
import argparse
import json
import re
import shutil
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime

import sourcemap
from my_libs.patched_path import Path
from my_libs.was_run_by_code_runner import f5_argv
from websockets.sync.client import ClientConnection, connect

F5_ARGS = r""

DEFAULT_EXPRESSIONS = ["2+2", "5 cm to inch", "sqrt(2)*[1,2]"]
PROJECT_FOLDER = Path(__file__).resolve().parent
PROFILES_FOLDER = PROJECT_FOLDER / "profiles"

#region #* Arguments
def parse_arguments(argv: list[str]) -> argparse.Namespace:
	parser = argparse.ArgumentParser(description = "CPU profile of the Worker's fetch() in the local wrangler dev")
	parser.add_argument("expressions", nargs = "*", default = DEFAULT_EXPRESSIONS,
		help = f"the expressions to profile, one profile each (default: {' '.join(DEFAULT_EXPRESSIONS)})")
	parser.add_argument("-n", "--requests", type = int, default = 4000, help = "profiled requests per expression (default 4000)")
	parser.add_argument("--connections", type = int, default = 4, help = "requests sent at once (default 4)")
	parser.add_argument("--warm_up", type = int, default = 3, help = "unprofiled requests before them (default 3)")
	parser.add_argument("--interval", type = int, default = 50,
		help = "sampling interval asked for, in microseconds (default 50; workerd samples far less often anyway)")
	parser.add_argument("--min_percent", type = float, default = 2.0,
		help = "the call tree leaves out what had a smaller share of fetch (default 2)")
	parser.add_argument("--top", type = int, default = 15, help = "rows of the function and line tables (default 15)")
	parser.add_argument("--server", default = "http://127.0.0.1:8787", help = "wrangler dev (default http://127.0.0.1:8787)")
	parser.add_argument("--inspector", default = "http://127.0.0.1:9229", help = "its inspector (default http://127.0.0.1:9229)")
	parser.add_argument("--flame", action = "store_true", help = "open each saved profile in speedscope")
	return parser.parse_args(argv)
#endregion

#* Chrome DevTools protocol
class Inspector:
	"""A connection to the V8 inspector of wrangler dev, sending one command at a time."""
	def __init__(self, inspector_url: str) -> None:
		with urllib.request.urlopen(f"{inspector_url}/json") as response:
			targets: list[dict] = json.load(response)
		# wrangler's inspector proxy turns away a connection without a local Origin
		self.connection: ClientConnection = connect(targets[0]["webSocketDebuggerUrl"], max_size = None,
			origin = "http://127.0.0.1")
		self.next_id = 1

	def send(self, method: str, params: dict | None = None) -> dict:
		"""Sends a command and returns its result, skipping the events that come in meanwhile."""
		command_id = self.next_id
		self.next_id += 1
		self.connection.send(json.dumps({"id": command_id, "method": method, "params": params or {}}))
		while True:
			message: dict = json.loads(self.connection.recv())
			if message.get("id") != command_id: continue
			if "error" in message: raise RuntimeError(f"{method}: {message['error']}")
			return message.get("result", {})  # workerd leaves out an empty result

	def close(self) -> None:
		self.connection.close()

#* Source map of wrangler's bundle
@dataclass(frozen = True)
class Location:
	path: Path | None  # None for what has no source (V8's own entries)
	line: int          # 1-based
	column: int        # 1-based

	def display(self) -> str:
		if self.path is None: return ""
		return f"{display_path(self.path)}:{self.line}"

def display_path(path: Path) -> str:
	"""A path inside node_modules/ from the package on, one in the project relative to it."""
	parts = path.parts
	if "node_modules" in parts: return "/".join(parts[len(parts) - parts[::-1].index("node_modules"):])
	if path.is_relative_to(PROJECT_FOLDER): return path.relative_to(PROJECT_FOLDER).as_posix()
	return path.as_posix()

class Bundle_mapper:
	"""Maps positions in wrangler's bundle - the script the profile calls "index.js" - to src/ and
	node_modules/, through the source map next to it."""
	BUNDLE_URL = "index.js"

	def __init__(self) -> None:
		bundles = sorted((PROJECT_FOLDER / ".wrangler" / "tmp").glob("dev-*/index.js"), key = lambda path: path.stat().st_mtime)
		if not bundles: raise RuntimeError("No .wrangler/tmp/dev-*/index.js - is wrangler dev running from this folder?")
		map_path = bundles[-1].with_name("index.js.map")  # the newest: the running server's
		self.index = sourcemap.loads(map_path.read_text())
		self.folder = map_path.parent
		self.first_on_line: dict[int, sourcemap.objects.Token] = {}
		for token in self.index:
			self.first_on_line.setdefault(token.dst_line, token)

	def source_path(self, source: str) -> Path:
		return (self.folder / source).resolve()

	def position(self, line: int, column: int) -> Location:
		"""The source of the 0-based bundle position."""
		try:
			token = self.index.lookup(line, column)
		except IndexError:
			return Location(None, line + 1, column + 1)
		return Location(self.source_path(token.src), token.src_line + 1, token.src_col + 1)

	def line(self, line: int) -> Location:
		"""The source of the 1-based bundle line (V8's line ticks have no column)."""
		token = self.first_on_line.get(line - 1)
		if token is None: return Location(None, line, 1)
		return Location(self.source_path(token.src), token.src_line + 1, 1)

#* Profiling
def get(url: str) -> float:
	"""Requests `url`, reads the whole answer, returns how long it took in seconds."""
	start = time.perf_counter()
	with urllib.request.urlopen(url) as response:
		response.read()
	return time.perf_counter() - start

def record_profile(inspector: Inspector, url: str, arguments: argparse.Namespace) -> tuple[dict, float]:
	"""The CPU profile of `arguments.requests` requests of `url`, sent `arguments.connections` at a
	time after `arguments.warm_up` unprofiled ones, and the mean wall-clock time of one in seconds."""
	for _ in range(arguments.warm_up):
		get(url)
	inspector.send("Profiler.enable")
	inspector.send("Profiler.setSamplingInterval", {"interval": arguments.interval})
	inspector.send("Profiler.start")
	try:
		with ThreadPoolExecutor(arguments.connections) as executor:
			wall_seconds = sum(executor.map(get, [url] * arguments.requests))
	finally:
		profile: dict = inspector.send("Profiler.stop")["profile"]
		inspector.send("Profiler.disable")
	return profile, wall_seconds / arguments.requests

#* Analysis
@dataclass(frozen = True)
class Frame:
	name: str
	location: Location

	def display(self) -> str:
		place = self.location.display()
		return f"{self.name}  {place}" if place else self.name

@dataclass
class Tree_node:
	samples: int = 0
	children: dict[Frame, "Tree_node"] = field(default_factory = dict)

@dataclass
class Analysis:
	categories: dict[str, int]                # samples: fetch(), GC, idle, ...
	self_samples: dict[Frame, int]            # inside fetch, by function
	total_samples: dict[Frame, int]           # inside fetch, callees included
	line_samples: dict[Location, int]         # inside fetch, by source line, self only
	tree: Tree_node                           # top-down from fetch
	fetch_frame: Frame | None                 # None when no sample fell inside fetch
	fetch_samples: int

WORKER_FETCH = Frame("fetch", Location(PROJECT_FOLDER / "src" / "index.ts", 1, 1))  # matched by name and file

def node_frames(profile: dict, mapper: Bundle_mapper) -> dict[int, Frame]:
	frames = {}
	for node in profile["nodes"]:
		call_frame: dict = node["callFrame"]
		name = call_frame["functionName"] or "(anonymous)"
		if call_frame["url"] == mapper.BUNDLE_URL:
			location = mapper.position(call_frame["lineNumber"], call_frame["columnNumber"])
		else:
			location = Location(None, call_frame["lineNumber"] + 1, call_frame["columnNumber"] + 1)
		frames[node["id"]] = Frame(name, location)
	return frames

def is_worker_fetch(frame: Frame) -> bool:
	return frame.name == WORKER_FETCH.name and frame.location.path == WORKER_FETCH.location.path

def analyze(profile: dict, mapper: Bundle_mapper) -> Analysis:
	frames = node_frames(profile, mapper)
	nodes = {node["id"]: node for node in profile["nodes"]}
	parents: dict[int, int] = {}
	for node in profile["nodes"]:
		for child in node.get("children", []):
			parents[child] = node["id"]
	categories: dict[str, int] = defaultdict(int)
	self_samples: dict[Frame, int] = defaultdict(int)
	total_samples: dict[Frame, int] = defaultdict(int)
	nodes_in_fetch: set[int] = set()
	tree = Tree_node()
	sample_ids: list[int] = profile["samples"]
	for node_id in sample_ids:
		stack = [node_id]  # leaf first
		while stack[-1] in parents:
			stack.append(parents[stack[-1]])
		fetch_index = next((index for index, stack_id in enumerate(stack) if is_worker_fetch(frames[stack_id])), None)
		if fetch_index is None:
			leaf = frames[node_id].name
			categories[leaf if leaf.startswith("(") else "workerd's JavaScript"] += 1
			continue
		categories["fetch()"] += 1
		nodes_in_fetch.add(node_id)
		self_samples[frames[node_id]] += 1
		inside = stack[:fetch_index + 1]
		for frame in {frames[stack_id] for stack_id in inside}:
			total_samples[frame] += 1
		branch = tree
		for stack_id in reversed(inside):
			branch = branch.children.setdefault(frames[stack_id], Tree_node())
			branch.samples += 1
	line_samples: dict[Location, int] = defaultdict(int)
	for node_id in nodes_in_fetch:
		if nodes[node_id]["callFrame"]["url"] != mapper.BUNDLE_URL: continue  # native code: lines of no file
		ticks: list[dict] = nodes[node_id].get("positionTicks", [])
		for line_ticks in ticks:
			line_samples[mapper.line(line_ticks["line"])] += line_ticks["ticks"]
	fetch_frame, fetch_tree = next(iter(tree.children.items()), (None, Tree_node()))
	return Analysis(categories, self_samples, total_samples, line_samples, fetch_tree, fetch_frame, categories["fetch()"])

#* Report
def share(part: int, whole: int) -> str:
	return f"{100 * part / whole:5.1f} %" if whole else "    - %"

def print_tree(node: Tree_node, frame: Frame, fetch_samples: int, min_percent: float, depth: int = 0) -> None:
	"""Prints `frame` and, indented, what it called with at least `min_percent` of fetch. A chain of
	calls within one file, each the only one big enough (math.js's parser descends through dozens),
	takes one line: its first function's share, then the last's children."""
	def big_enough(child: Tree_node) -> bool:
		return 100 * child.samples / fetch_samples >= min_percent
	top_samples = node.samples
	chain = [frame]
	while True:
		visible = [(child_frame, child) for child_frame, child in node.children.items() if big_enough(child)]
		if len(visible) != 1 or visible[0][0].location.path is None or visible[0][0].location.path != frame.location.path: break
		frame, node = visible[0]
		chain.append(frame)
	label = chain[0].display()
	if len(chain) > 1: label = f"{chain[0].name} > ... > {chain[-1].display()}  ({len(chain)} nested calls)"
	print(f"   {share(top_samples, fetch_samples)} {top_samples:>5}  {'   ' * depth}{label}")
	hidden = 0
	for child_frame, child in sorted(node.children.items(), key = lambda item: -item[1].samples):
		if not big_enough(child):
			hidden += child.samples
			continue
		print_tree(child, child_frame, fetch_samples, min_percent, depth + 1)
	if 100 * hidden / fetch_samples >= min_percent:
		print(f"   {share(hidden, fetch_samples)} {hidden:>5}  {'   ' * (depth + 1)}(the rest, each < {min_percent:g} %)")

def print_report(expression: str, analysis: Analysis, wall_seconds: float, arguments: argparse.Namespace) -> None:
	fetch_samples = analysis.fetch_samples
	print(f"\n#* {expression}  ({arguments.requests} requests, {arguments.connections} at a time,"
		f" {wall_seconds * 1000:.2f} ms each on the client's wall clock)")
	print("   samples:", ", ".join(f"{name} {count}"
		for name, count in sorted(analysis.categories.items(), key = lambda item: -item[1])))
	if analysis.fetch_frame is None:
		print("   No sample fell inside fetch() - send more requests (-n).")
		return
	print(f"   shares of fetch() below are good to about +-{100 / fetch_samples ** 0.5:.0f} % for a whole fetch;"
		" a function's share is as good as its own sample count allows")
	print(f"\n   {'Functions inside fetch(), by total share':<58}     total            self")
	for frame, total in sorted(analysis.total_samples.items(), key = lambda item: -item[1])[:arguments.top]:
		self_count = analysis.self_samples.get(frame, 0)
		print(f"   {frame.display()[:58]:<58} {share(total, fetch_samples)} {total:>5}"
			f"  {share(self_count, fetch_samples)} {self_count:>5}")
	print("\n   Call tree from fetch() (share, samples)")
	print_tree(analysis.tree, analysis.fetch_frame, fetch_samples, arguments.min_percent)
	own_lines = {location: count for location, count in analysis.line_samples.items()
		if location.path is not None and location.path.is_relative_to(PROJECT_FOLDER / "src")}
	print("\n   Lines of src/ by self share (what they call is not included)")
	for location, count in sorted(own_lines.items(), key = lambda item: -item[1])[:arguments.top]:
		print(f"   {share(count, fetch_samples)} {count:>5}  {location.display()}  {source_line(location)}")

def source_line(location: Location) -> str:
	if location.path is None or not location.path.is_file(): return ""
	lines = location.path.read_text().splitlines()
	return lines[location.line - 1].strip()[:70] if location.line <= len(lines) else ""

#* Saving
def viewer_profile(profile: dict, mapper: Bundle_mapper) -> dict:
	"""A copy of `profile` for a viewer: bundle positions point into src/ and node_modules/ instead,
	and every sample lasts 1 ms, so widths are sample shares."""
	mapped = json.loads(json.dumps(profile))
	for node in mapped["nodes"]:
		call_frame: dict = node["callFrame"]
		if call_frame["url"] != mapper.BUNDLE_URL: continue
		location = mapper.position(call_frame["lineNumber"], call_frame["columnNumber"])
		if location.path is None: continue
		call_frame.update(url = location.path.as_uri(), lineNumber = location.line - 1, columnNumber = location.column - 1)
		line_ticks: dict[int, int] = defaultdict(int)
		for ticks in node.get("positionTicks", []):
			line_ticks[mapper.line(ticks["line"]).line] += ticks["ticks"]
		if line_ticks: node["positionTicks"] = [{"line": line, "ticks": ticks} for line, ticks in line_ticks.items()]
	mapped["timeDeltas"] = [1000] * len(mapped["samples"])
	mapped["endTime"] = mapped["startTime"] + 1000 * len(mapped["samples"])
	return mapped

def save_profile(profile: dict, expression: str) -> Path:
	PROFILES_FOLDER.mkdir(exist_ok = True)
	slug = re.sub(r"[^0-9A-Za-z]+", "_", expression).strip("_")[:40] or "expression"
	path = PROFILES_FOLDER / f"{datetime.now():%Y-%m-%d_%H-%M-%S}_{slug}.cpuprofile"
	path.write_text(json.dumps(profile))
	return path

def open_flame_graph(path: Path) -> None:
	speedscope = shutil.which("speedscope")
	if speedscope is None:
		print("   speedscope is not installed (npm i -g speedscope)")
		return
	subprocess.run([speedscope, str(path)], check = True)

#* Main
def main() -> int:
	arguments = parse_arguments(f5_argv(F5_ARGS))
	try:
		get(arguments.server + "/embed")
		inspector = Inspector(arguments.inspector)
	except (urllib.error.URLError, OSError) as error:
		print(f"wrangler dev does not answer ({error}) - start it with run_local_server.ps1")
		return 1
	try:
		mapper = Bundle_mapper()
		for expression in arguments.expressions:
			url = f"{arguments.server}/embed?expression={urllib.parse.quote(expression, safe = '')}"
			profile, wall_seconds = record_profile(inspector, url, arguments)
			print_report(expression, analyze(profile, mapper), wall_seconds, arguments)
			path = save_profile(viewer_profile(profile, mapper), expression)
			print(f"\n   Saved {display_path(path)}")
			if arguments.flame: open_flame_graph(path)
	finally:
		inspector.close()
	return 0

if __name__ == "__main__":
	raise SystemExit(main())
