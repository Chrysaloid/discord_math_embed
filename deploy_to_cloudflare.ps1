<#
.SYNOPSIS
	Checks that the Worker is ready to go live, deploys it to Cloudflare, and checks the deployed Worker.

.DESCRIPTION
	Started from anywhere - F5 in VS Code, Explorer, a shell - it runs these checks, cheapest first, and
	stops at the first one that fails, before anything is uploaded:

		the tools        wrangler, tsc, esbuild, html-minifier-terser, eslint, npm and git are on PATH
		git              no uncommitted or untracked changes, so what goes live is a commit
		dependencies     npm ls: node_modules holds what package-lock.json says
		Cloudflare login wrangler whoami: logged in (wrangler login, once)
		types            npm run typecheck (wrangler strips the types without checking them)
		lint             eslint, with no errors and no warnings either

	Then it runs wrangler deploy, which builds dist/creator.js and build/embed.html first ([build] in
	wrangler.toml), with the commit's short hash and subject as the version's message. Last, it checks the
	address wrangler deployed to: /embed?expression=2%2B2 must answer with the og:title "2+2 = 4", and
	/creator.js must be served - retried for up to 30 s. When that fails, the Worker is live but broken,
	and `wrangler rollback` brings the previous version back.

	-dry_run runs every check and then wrangler deploy --dry-run, which builds and bundles without
	uploading, so nothing is deployed and nothing is checked online. -allow_dirty deploys uncommitted
	changes too; the version's message then says so.

	Exit code 0 when the deployed Worker answers right (or the dry run passed), 1 otherwise. Started by
	Explorer in a Terminal tab of its own, it waits for Enter after a failure, so the tab stays readable.
#>
param([switch] $dry_run, [switch] $allow_dirty)

$ErrorActionPreference = 'Stop'
. G:\Tools\wt_tabs.ps1
Set-Location $PSScriptRoot

#* Settings
$REQUIRED_TOOLS = 'wrangler', 'tsc', 'esbuild', 'html-minifier-terser', 'eslint', 'npm', 'git'
$TEST_EXPRESSION = '2+2'
$EXPECTED_TITLE = '2+2 = 4'
$VERIFY_TIMEOUT_SECONDS = 30
$VERSION_MESSAGE_LENGTH = 100  # Cloudflare's limit on a version's message

#* Helpers
function finish([int] $exit_code) {
	if ($exit_code -ne 0 -and (test_wt_tab_process)) { [void] (wait_after_wt_tab_failure $exit_code) }
	exit (get_wt_tab_exit_code $exit_code)
}

function fail([string] $message) {
	Write-Host "`n$message" -ForegroundColor Red
	finish 1
}

# runs $command with its output held back, which is printed only when it fails
function invoke_check([string] $name, [scriptblock] $command) {
	$global:LASTEXITCODE = 0
	$output = & $command
	if ($LASTEXITCODE) {
		$output | Out-Host
		fail "$name failed (exit code $LASTEXITCODE) - nothing was deployed."
	}
	Write-Host "OK  $name"
}

# the deployed page and /creator.js, or the problem with them; $null when both are right
function get_deployment_problem([string] $base_url) {
	$embed_url = "$base_url/embed?expression=$([uri]::EscapeDataString($TEST_EXPRESSION))"
	$page = Invoke-WebRequest $embed_url -SkipHttpErrorCheck -TimeoutSec 10
	if ($page.StatusCode -ne 200) { return "$embed_url answered $($page.StatusCode)" }
	$title_tag = "<meta property=""og:title"" content=""$EXPECTED_TITLE"">"
	if (-not $page.Content.Contains($title_tag)) { return "$embed_url has no $title_tag" }
	$script_url = "$base_url/creator.js"
	$script = Invoke-WebRequest $script_url -SkipHttpErrorCheck -TimeoutSec 10
	if ($script.StatusCode -ne 200) { return "$script_url answered $($script.StatusCode)" }
	if ("$($script.Headers['Content-Type'])" -notmatch 'javascript') {
		return "$script_url came as $($script.Headers['Content-Type']), not JavaScript"
	}
	$null
}

#* Checks
$missing = $REQUIRED_TOOLS | Where-Object { -not (Get-Command $_ -ErrorAction SilentlyContinue) }
if ($missing) { fail "Not on PATH: $($missing -join ', ') - nothing was deployed." }
Write-Host 'OK  the tools'

$changes = git status --porcelain
if ($LASTEXITCODE) { fail 'git status failed - nothing was deployed.' }
$commit = git log -1 --format='%h %s'
if ($changes -and -not $allow_dirty) {
	$changes | Out-Host
	fail 'Uncommitted changes - commit them first (or deploy them anyway with -allow_dirty). Nothing was deployed.'
}
if ($changes) {
	$commit = $commit -replace '^(\S+)', '$1 + uncommitted changes:'
	Write-Host 'OK  git (uncommitted changes allowed by -allow_dirty)' -ForegroundColor Yellow
}
else { Write-Host 'OK  git' }

invoke_check 'dependencies (npm ls)' { npm ls --depth=0 2>&1 }

$global:LASTEXITCODE = 0
$whoami = wrangler whoami 2>&1
if ($LASTEXITCODE -or -not ($whoami -match 'You are logged in')) {
	$whoami | Out-Host
	fail 'Not logged in to Cloudflare - run wrangler login first. Nothing was deployed.'
}
Write-Host 'OK  Cloudflare login'

invoke_check 'types (npm run typecheck)' { npm run --silent typecheck 2>&1 }
invoke_check 'lint (eslint)' { eslint . --max-warnings 0 2>&1 }

#* Deploy
$message = if ($commit.Length -gt $VERSION_MESSAGE_LENGTH) { $commit.Substring(0, $VERSION_MESSAGE_LENGTH) } else { $commit }
if ($dry_run) {
	Write-Host "`nwrangler deploy --dry-run`n"
	wrangler deploy --dry-run
	if ($LASTEXITCODE) { fail "wrangler deploy --dry-run failed (exit code $LASTEXITCODE)." }
	Write-Host "`nThe dry run passed; nothing was deployed." -ForegroundColor Green
	finish 0
}
Write-Host "`nwrangler deploy --message ""$message""`n"
$global:LASTEXITCODE = 0
wrangler deploy --message $message 2>&1 | Tee-Object -Variable deploy_output | Out-Host
if ($LASTEXITCODE) { fail "wrangler deploy failed (exit code $LASTEXITCODE)." }

#* Check the deployed Worker
$base_url = "$deploy_output" | Select-String 'https://[\w.-]+\.workers\.dev' | ForEach-Object { $_.Matches[0].Value }
if (-not $base_url) { fail 'Deployed, but wrangler printed no workers.dev address to check.' }
$deadline = (Get-Date).AddSeconds($VERIFY_TIMEOUT_SECONDS)
do {
	try { $problem = get_deployment_problem $base_url } catch { $problem = $_.Exception.Message }
	if (-not $problem) { break }
	Start-Sleep -Seconds 2
} while ((Get-Date) -lt $deadline)
if ($problem) {
	fail "Deployed, but the Worker does not answer right: $problem`nwrangler rollback brings the previous version back."
}
Write-Host "`nDeployed and checked: $base_url/embed?expression=$([uri]::EscapeDataString($TEST_EXPRESSION)) is ""$EXPECTED_TITLE""." -ForegroundColor Green
finish 0
