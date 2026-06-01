[Setup]
AppName=IPTV v2 Premium
AppVersion=2.0
DefaultDirName={autopf}\IPTV_v2
DefaultGroupName=IPTV v2
OutputBaseFilename=IPTV_v2_Installer
Compression=lzma2
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64
PrivilegesRequired=lowest

[Files]
Source: "dist\IPTV_v2\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\IPTV v2 Premium"; Filename: "{app}\IPTV_v2.exe"
Name: "{autodesktop}\IPTV v2 Premium"; Filename: "{app}\IPTV_v2.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional icons:"
