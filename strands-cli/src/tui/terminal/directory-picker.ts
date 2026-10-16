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

const MACOS_FILE_PICKER = `
ObjC.import('AppKit')

function run(argv) {
  const app = $.NSApplication.sharedApplication
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory)
  const panel = $.NSOpenPanel.openPanel
  panel.title = argv[0] || 'Attach files'
  panel.message = 'Choose files to attach to your next message'
  panel.canChooseFiles = true
  panel.canChooseDirectories = false
  panel.allowsMultipleSelection = true
  panel.makeKeyAndOrderFront(null)
  app.activateIgnoringOtherApps(true)
  if (panel.runModal !== $.NSModalResponseOK) return ''
  const paths = []
  for (let index = 0; index < panel.URLs.count; index++) {
    paths.push(ObjC.unwrap(panel.URLs.objectAtIndex(index).path))
  }
  return paths.join('\\n')
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

const WINDOWS_FOLDER_PICKER = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = $env:STRANDS_PICKER_PROMPT
$dialog.ShowNewFolderButton = $true
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
  [Console]::Write($dialog.SelectedPath)
}
`

const WINDOWS_AGENT_PICKER = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Import an agent'
$dialog.Filter = 'Agent projects (*.zip;*.ts;*.js;*.mjs;*.mts;*.py)|*.zip;*.ts;*.js;*.mjs;*.mts;*.py|All files (*.*)|*.*'
$dialog.Multiselect = $false
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
  [Console]::Write($dialog.FileName)
}
`

const WINDOWS_FILE_PICKER = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = $env:STRANDS_PICKER_PROMPT
$dialog.Filter = 'Supported files|*.png;*.jpg;*.jpeg;*.gif;*.webp;*.pdf;*.doc;*.docx;*.xls;*.xlsx;*.csv;*.html;*.txt;*.md;*.json;*.xml|All files (*.*)|*.*'
$dialog.Multiselect = $true
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
  [Console]::Write(($dialog.FileNames -join [Environment]::NewLine))
}
`

interface PickerInvocation {
  command: string
  args: readonly string[]
  environment?: Readonly<Record<string, string>>
}

export function canUseNativePicker(platform = process.platform): boolean {
  return platform === 'darwin' || platform === 'win32'
}

function windowsPicker(script: string, environment?: Readonly<Record<string, string>>): PickerInvocation {
  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
    ...(environment ? { environment } : {}),
  }
}

export function chooseDirectory(prompt = 'Choose a directory'): Promise<string | undefined> {
  if (process.platform === 'win32') {
    return runPicker(windowsPicker(WINDOWS_FOLDER_PICKER, { STRANDS_PICKER_PROMPT: prompt }))
  }
  return runPicker({ command: '/usr/bin/osascript', args: ['-e', MACOS_FOLDER_PICKER, '--', prompt] })
}

export function chooseAgentProject(): Promise<string | undefined> {
  if (process.platform === 'win32') {
    return runPicker(windowsPicker(WINDOWS_AGENT_PICKER))
  }
  return runPicker({ command: '/usr/bin/osascript', args: ['-l', 'JavaScript', '-e', MACOS_AGENT_PICKER] })
}

export async function chooseFiles(prompt = 'Attach files'): Promise<string[]> {
  const output =
    process.platform === 'win32'
      ? await runPicker(windowsPicker(WINDOWS_FILE_PICKER, { STRANDS_PICKER_PROMPT: prompt }))
      : await runPicker({
          command: '/usr/bin/osascript',
          args: ['-l', 'JavaScript', '-e', MACOS_FILE_PICKER, '--', prompt],
        })
  return output?.split(/\r?\n/).filter(Boolean) ?? []
}

export function chooseSaveFile(prompt: string, defaultName: string): Promise<string | undefined> {
  if (process.platform === 'win32') {
    return runPicker(
      windowsPicker(WINDOWS_SAVE_PICKER, { STRANDS_PICKER_PROMPT: prompt, STRANDS_PICKER_DEFAULT_NAME: defaultName })
    )
  }
  return runPicker({ command: '/usr/bin/osascript', args: ['-e', MACOS_SAVE_PICKER, '--', prompt, defaultName] })
}

let pickerActive = false

async function runPicker(invocation: PickerInvocation): Promise<string | undefined> {
  if (!canUseNativePicker() || pickerActive) {
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
