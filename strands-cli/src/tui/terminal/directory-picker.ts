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

export function canChooseDirectory(): boolean {
  return process.platform === 'darwin'
}

export function chooseDirectory(prompt = 'Choose a directory'): Promise<string | undefined> {
  return runPicker(['-e', MACOS_FOLDER_PICKER, '--', prompt])
}

export function chooseAgentProject(): Promise<string | undefined> {
  return runPicker(['-l', 'JavaScript', '-e', MACOS_AGENT_PICKER])
}

export function chooseSaveFile(prompt: string, defaultName: string): Promise<string | undefined> {
  return runPicker(['-e', MACOS_SAVE_PICKER, '--', prompt, defaultName])
}

let pickerActive = false

async function runPicker(args: readonly string[]): Promise<string | undefined> {
  if (!canChooseDirectory() || pickerActive) {
    return undefined
  }
  pickerActive = true
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile('/usr/bin/osascript', args, { encoding: 'utf8' }, (error, stdout) => {
        if (error) {
          reject(new Error('Unable to open the picker.', { cause: error }))
          return
        }
        resolve(stdout)
      })
    })
    return stdout.trim() || undefined
  } finally {
    pickerActive = false
  }
}
