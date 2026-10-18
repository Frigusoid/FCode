# Screen capture of this machine: the mstsc window shows the remote desktop.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Bring the RDP client window to the front, otherwise the shot may miss it.
$activated = $false
try {
  $proc = Get-Process -Name mstsc -ErrorAction Stop | Select-Object -First 1
  $shell = New-Object -ComObject WScript.Shell
  $activated = $shell.AppActivate($proc.Id)
} catch {
  Write-Host "mstsc not running"
}

Start-Sleep -Milliseconds 1500

$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$graphics.Dispose()

$out = 'D:\FCode-work\rdp-screen.png'
$bitmap.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()

Write-Host "activated: $activated"
Write-Host "saved: $out"
Write-Host "size: $($bounds.Width)x$($bounds.Height)"
