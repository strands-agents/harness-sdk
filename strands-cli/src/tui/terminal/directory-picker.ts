import { execFile } from 'node:child_process'

const MACOS_FOLDER_PICKER = `
on run argv
  try
    tell application "Finder"
      activate
      return POSIX path of (choose folder with prompt (item 1 of argv))
    end tell
  on error number -128
    return ""
  end try
end run
`

const MACOS_AGENT_PICKER = `
ObjC.import('AppKit')

function run() {
  const app = $.NSApplication.sharedApplication
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory)
  const panel = $.NSOpenPanel.openPanel
  panel.title = 'Import an agent'
  panel.message = 'Choose an agent ZIP, source file, or project folder'
  panel.canChooseFiles = true
  panel.canChooseDirectories = true
  panel.allowsMultipleSelection = false
  panel.makeKeyAndOrderFront(null)
  app.activateIgnoringOtherApps(true)
  return panel.runModal === $.NSModalResponseOK ? ObjC.unwrap(panel.URL.path) : ''
}
`

const MACOS_SAVE_PICKER = `
on run argv
  try
    tell application "Finder" to activate
    delay 0.1
    return POSIX path of (choose file name with prompt (item 1 of argv) default name (item 2 of argv) default location (path to downloads folder))
  on error number -128
    return ""
  end try
end run
`

const WINDOWS_SAVE_PICKER = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$dialog = New-Object System.Windows.Forms.SaveFileDialog
$dialog.Title = $env:STRANDS_PICKER_PROMPT
$dialog.FileName = $env:STRANDS_PICKER_DEFAULT_NAME
$dialog.Filter = 'ZIP archive (*.zip)|*.zip|All files (*.*)|*.*'
$dialog.DefaultExt = 'zip'
$dialog.AddExtension = $true
$dialog.OverwritePrompt = $true
$downloads = Join-Path $env:USERPROFILE 'Downloads'
if (Test-Path -LiteralPath $downloads) {
  $dialog.InitialDirectory = $downloads
}
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
  [Console]::Write($dialog.FileName)
}
`

interface PickerInvocation {
  command: string
  args: readonly string[]
  environment?: Readonly<Record<string, string>>
}

export function canChooseDirectory(platform = process.platform): boolean {
  return platform === 'darwin'
}

export function canChooseSaveFile(platform = process.platform): boolean {
  return platform === 'darwin' || platform === 'win32'
}

export function chooseDirectory(prompt = 'Choose a directory'): Promise<string | undefined> {
  return runPicker(
    { command: '/usr/bin/osascript', args: ['-e', MACOS_FOLDER_PICKER, '--', prompt] },
    canChooseDirectory()
  )
}

export function chooseAgentProject(): Promise<string | undefined> {
  return runPicker(
    { command: '/usr/bin/osascript', args: ['-l', 'JavaScript', '-e', MACOS_AGENT_PICKER] },
    canChooseDirectory()
  )
}

export function chooseSaveFile(prompt: string, defaultName: string): Promise<string | undefined> {
  if (process.platform === 'win32') {
    return runPicker(
      {
        command: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SAVE_PICKER],
        environment: {
          STRANDS_PICKER_PROMPT: prompt,
          STRANDS_PICKER_DEFAULT_NAME: defaultName,
        },
      },
      true
    )
  }
  return runPicker(
    { command: '/usr/bin/osascript', args: ['-e', MACOS_SAVE_PICKER, '--', prompt, defaultName] },
    canChooseSaveFile()
  )
}

let pickerActive = false

async function runPicker(invocation: PickerInvocation, available: boolean): Promise<string | undefined> {
  if (!available || pickerActive) {
    return undefined
  }
  pickerActive = true
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        invocation.command,
        invocation.args,
        {
          encoding: 'utf8',
          windowsHide: true,
          ...(invocation.environment ? { env: { ...process.env, ...invocation.environment } } : {}),
        },
        (error, output) => {
          if (error) {
            reject(new Error('Unable to open the picker.', { cause: error }))
            return
          }
          resolve(output)
        }
      )
    })
    return stdout.trim() || undefined
  } finally {
    pickerActive = false
  }
}
