Set fso = CreateObject("Scripting.FileSystemObject")
dirPath = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = dirPath

exePath = dirPath & "\node_modules\electron\dist\electron.exe"
If Not fso.FileExists(exePath) Then
  MsgBox "Electron runtime not found." & vbCrLf & "Run: npm install", 48, "DeepSeek Quick"
  WScript.Quit
End If

sh.Run """" & exePath & """ .", 0, False
