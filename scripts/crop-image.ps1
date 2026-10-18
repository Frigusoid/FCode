# Crop a region of a screenshot and scale it up for readability.
param(
  [string]$In = 'D:\FCode-work\rdp-screen.png',
  [string]$Out = 'D:\FCode-work\rdp-crop.png',
  [int]$X = 200,
  [int]$Y = 50,
  [int]$W = 1300,
  [int]$H = 900,
  [double]$Scale = 1.6
)

Add-Type -AssemblyName System.Drawing

$source = [System.Drawing.Image]::FromFile($In)
$rect = New-Object System.Drawing.Rectangle($X, $Y, $W, $H)
$crop = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($crop)
$g.DrawImage($source, (New-Object System.Drawing.Rectangle(0, 0, $W, $H)), $rect, [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()
$source.Dispose()

$newW = [int]($W * $Scale)
$newH = [int]($H * $Scale)
$big = New-Object System.Drawing.Bitmap($newW, $newH)
$g2 = [System.Drawing.Graphics]::FromImage($big)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($crop, 0, 0, $newW, $newH)
$g2.Dispose()
$crop.Dispose()

$big.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$big.Dispose()

Write-Host "saved: $Out ($newW x $newH)"
