Set fso = CreateObject("Scripting.FileSystemObject")
dirPath = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = dirPath

exePath = dirPath & "\node_modules\electron\dist\DeepSeek Quick.exe"
If Not fso.FileExists(exePath) Then
  ' Electron 45 起运行时按需下载，先补一次运行时和品牌化
  sh.Run "cmd /c node """ & dirPath & "\scripts\prepare-runtime.js""", 1, True
End If
If Not fso.FileExists(exePath) Then
  exePath = dirPath & "\node_modules\electron\dist\electron.exe"
End If
If Not fso.FileExists(exePath) Then
  MsgBox "Electron runtime not found." & vbCrLf & "Run: npm install", 48, "DeepSeek Quick"
  WScript.Quit
End If

sh.Run """" & exePath & """ """ & dirPath & """", 0, False
