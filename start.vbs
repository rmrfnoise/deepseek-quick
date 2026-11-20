Set fso = CreateObject("Scripting.FileSystemObject")
dirPath = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = dirPath

exePath = dirPath & "\node_modules\electron\dist\DeepSeek Quick.exe"
If Not fso.FileExists(exePath) Then
  exePath = dirPath & "\node_modules\electron\dist\electron.exe"
End If
If Not fso.FileExists(exePath) Then
  MsgBox "Electron runtime not found." & vbCrLf & "Run: npm install", 48, "DeepSeek Quick"
  WScript.Quit
End If

sh.Run """" & exePath & """ """ & dirPath & """", 0, False
