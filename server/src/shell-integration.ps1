# Perch shell integration for PowerShell - written by Perch at
# startup; edits are overwritten. The app's own PowerShell terminals load it
# automatically; for any other setup, add this line to your PowerShell
# profile (the file $PROFILE names), then open a new terminal:
#   __SOURCE_LINE__
#
# Inside Perch's terminals this marks prompts (OSC 133, for jumping
# between them), reports the working directory (OSC 7) and reports each
# command's start and end to the local Perch for command history and
# finished-command notifications. It does nothing in other terminals.
# Reports are sent without waiting and never hold up the prompt.

if (-not $env:PERCH_WINDOW -or $global:__PerchIntegration) { return }
$global:__PerchIntegration = $true
$global:__PerchSeq = 0
$global:__PerchRan = $false
$global:__PerchCmd = ''
$global:__PerchHttp = [System.Net.Http.HttpClient]::new()
$global:__PerchHttp.Timeout = [TimeSpan]::FromSeconds(1)

# shell + seq pair each end report with its start (see the bash/zsh script).
# The custom header is the CSRF guard the report route requires.
function global:__PerchReport([string]$Event, [string]$Command, [string]$Exit) {
  try {
    $form = [System.Collections.Generic.Dictionary[string, string]]::new()
    $form['pane'] = $env:PERCH_WINDOW
    $form['shell'] = [string]$PID
    $form['seq'] = [string]$global:__PerchSeq
    $form['event'] = $Event
    $form['command'] = $Command
    $form['cwd'] = (Get-Location).ProviderPath
    $form['exit'] = $Exit
    $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, 'http://127.0.0.1:__PORT__/api/command-events/report')
    $request.Headers.Add('X-Perch-Events', '1')
    $request.Content = [System.Net.Http.FormUrlEncodedContent]::new($form)
    [void]$global:__PerchHttp.SendAsync($request)
  } catch {}
}

$global:__PerchOriginalPrompt = $function:prompt

function global:prompt {
  # Read before anything else runs and changes them.
  $succeeded = $?
  $code = if ($succeeded) { 0 } elseif ($global:LASTEXITCODE) { $global:LASTEXITCODE } else { 1 }
  $esc = [char]27
  $st = "$esc\"
  $cwd = (Get-Location).ProviderPath
  $url = 'file://' + [System.Environment]::MachineName + '/' + ($cwd -replace '\\', '/')
  $out = "$esc]133;D;$code$st$esc]7;$url$st"
  if ($global:__PerchRan) {
    $global:__PerchRan = $false
    __PerchReport 'end' $global:__PerchCmd ([string]$code)
  }
  $out += "$esc]133;A$st"
  $out += (& $global:__PerchOriginalPrompt)
  $out += "$esc]133;B$st"
  return $out
}

# Command start: PSReadLine's Enter handler sees the line before it runs.
if (Get-Module PSReadLine) {
  Set-PSReadLineKeyHandler -Chord Enter -ScriptBlock {
    $line = $null
    $cursor = $null
    [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)
    if ($line.Trim()) {
      $global:__PerchSeq++
      $global:__PerchCmd = $line
      $global:__PerchRan = $true
      [Console]::Write("$([char]27)]133;C$([char]27)\")
      __PerchReport 'start' $line ''
    }
    [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
  }
}
