<#
.SYNOPSIS
	Runs the Worker locally (wrangler dev) in a Windows Terminal tab of its own, closing the tab of the
	previous run first.

.DESCRIPTION
	Started from anywhere - F5 in VS Code, Explorer, a shell - it closes every Terminal tab titled
	"discord_math_embed server" (the one a previous run opened, running or sitting on an error), waits for
	the port to be free, and reopens itself in a new tab with that title, where it runs

		wrangler dev --ip 127.0.0.1 --port <port>

	It returns once http://127.0.0.1:<port>/ answers, and fails when the tab's server never does. In the tab,
	wrangler's own keys work (b opens the browser, x stops it); when wrangler fails, the tab stays open until
	Enter. Test with, for example:

		http://127.0.0.1:8787/embed?expression=2%2B2

	-port picks another port (default 8787). -in_tab is what the reopened copy gets; with it the script runs
	wrangler right where it was started.
#>
param([int] $port = 8787, [switch] $in_tab)

$ErrorActionPreference = 'Stop'
. G:\Tools\wt_tabs.ps1
$TAB_TITLE = 'discord_math_embed server'

#* In the tab: the server itself
if ($in_tab) {
	Set-Location $PSScriptRoot
	wrangler dev --ip 127.0.0.1 --port $port
	exit_wt_tab $LASTEXITCODE
}

function test_port_listening([int] $port) {
	$client = [System.Net.Sockets.TcpClient]::new()
	try { $client.ConnectAsync('127.0.0.1', $port).Wait(300) } catch { $false } finally { $client.Dispose() }
}

#* Close the previous run's tab
$previous = find_wt_tabs @(get_wt_tabs) "^$([regex]::Escape($TAB_TITLE))$"
foreach ($tab in $previous) {
	if (-not (close_wt_tab $tab)) { throw "the previous tab ($($tab.position)) did not close within 2 s" }
	Write-Host "Closed the previous tab ($($tab.position))."
}

#* Wait for the port to be free - wrangler and its workerd need a moment to exit
$deadline = (Get-Date).AddSeconds(10)
while ((test_port_listening $port) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
if (test_port_listening $port) { throw "port $port is still taken by another program" }

#* Reopen this script in a new tab, and wait until the server answers
$script = $PSCommandPath
$url = "http://127.0.0.1:$port/"
[void] (open_wt_tab -timeout_seconds 60 -tab @{
	Title = $TAB_TITLE; keep_title = $true; Directory = $PSScriptRoot
	Command = "$PSHOME\pwsh.exe", '-NoLogo', '-File', $script, '-in_tab:$true', '-port', $port
	Expect = "*$([WildcardPattern]::Escape([IO.Path]::GetFileName($script)))*-in_tab*"
	health_url = $url
})
Write-Host "The server answers at $url (tab ""$TAB_TITLE"")."
