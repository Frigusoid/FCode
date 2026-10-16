# FCode
An Xcode-like IDE for Windows: write Swift/SwiftUI, build .ipa via xtool in WSL, no Mac required.
<div align="center">
  <img src="github/Fcode.gif" width="566" alt="Fcode logo">
</div>

#	What	Where
1	wsl --install --no-distribution, reboot	PowerShell (admin)
2	wsl --install -d Ubuntu	PowerShell
3	Swift 6.1	Ubuntu
4	sudo apt-get install -y usbmuxd libimobiledevice-utils	Ubuntu
5	xtool AppImage	Ubuntu
6	winget install usbipd + usbipd attach --wsl	PowerShell
7	Xcode.xip (~10 GB) from [developer.apple.com](https://download.developer.apple.com/Developer_Tools/Xcode_16.4/Xcode_16.4.xip)	Windows
8	xtool setup → Password mode → path to Xcode.xip	Ubuntu
9	xtool auth	Ubuntu
