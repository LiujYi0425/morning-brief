' =====================================================================
' Morning Brief launcher: status   (double-click to read the running status)
' =====================================================================
' THIS FILE MUST STAY PURE ASCII. Do not add Chinese (or any non-ASCII)
' text here -- not even in comments, and not even the file's own name.
'
' Why: Windows Script Host reads .vbs using the system ANSI code page
' (GBK on a Simplified-Chinese machine), while every other source file in
' this repo is UTF-8 without BOM. Non-ASCII text here would be decoded as
' mojibake -- and you would only find out at runtime, on the user machine.
'
' All user-facing text (including Chinese) comes from tools/service.mjs,
' which Node reads as UTF-8. This file is a dumb shim on purpose: every
' explanation lives in a UTF-8 file where it cannot be corrupted.
'
' The three launchers (start / stop / status) are deliberately identical
' except for the subcommand, so there is nothing to get subtly wrong.
' =====================================================================

Option Explicit

Dim sh, fso, root, nodePath, cmd, tmp, f, rc

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = root

nodePath = ""
tmp = sh.ExpandEnvironmentStrings("%TEMP%") & "\mb-where-node.txt"
On Error Resume Next
sh.Run "cmd.exe /c where node > """ & tmp & """ 2>nul", 0, True
If fso.FileExists(tmp) Then
  Set f = fso.OpenTextFile(tmp, 1)
  If Not f.AtEndOfStream Then nodePath = Trim(f.ReadLine())
  f.Close
  fso.DeleteFile tmp, True
End If
On Error GoTo 0

If nodePath = "" Then
  MsgBox "Cannot find node.exe." & vbCrLf & vbCrLf & _
         "Install Node.js from https://nodejs.org and make sure 'node'" & vbCrLf & _
         "works in a new terminal window.", _
         16, "Morning Brief"
  WScript.Quit 1
End If

cmd = """" & nodePath & """ """ & root & "\tools\service.mjs"""

' The status report has to be READ, so it gets a visible console that stays
' open (cmd /k). A hidden window here would be the wrong design: it would
' look like something happened while showing nothing at all.
If "status" = "status" Then
  sh.Run "cmd.exe /k """ & cmd & " status""", 1, False
  WScript.Quit 0
End If

On Error Resume Next
rc = sh.Run(cmd & " status", 0, True)
If Err.Number <> 0 Then
  MsgBox "Failed to run status: " & Err.Description, 16, "Morning Brief"
  WScript.Quit 1
End If
On Error GoTo 0

If rc <> 0 Then
  ' A hidden failure is invisible -- run it again VISIBLY so the user sees
  ' the real error message instead of a useless "failed" popup.
  sh.Run "cmd.exe /k """ & cmd & " status""", 1, False
  WScript.Quit rc
End If

WScript.Quit 0