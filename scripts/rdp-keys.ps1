# Activate the RDP window, send keystrokes into the remote session, screenshot.
param(
  [string]$Keys = '',
  [int]$WaitMs = 1200,
  [string]$Out = 'D:\FCode-work\rdp-step.png'
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$activated = $false
try {
  $proc = Get-Process -Name mstsc -ErrorAction Stop | Select-Object -First 1
  $shell = New-Object -ComObject WScript.Shell
  $activated = $shell.AppActivate($proc.Id)
} catch {
  Write-Host 'mstsc not running'
}

Start-Sleep -Milliseconds 600

if ($Keys -ne '') {
  [System.Windows.Forms.SendKeys]::SendWait($Keys)
  Start-Sleep -Milliseconds $WaitMs
}

$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$graphics.Dispose()
$bitmap.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()

Write-Host "activated: $activated"
Write-Host "saved: $Out"
