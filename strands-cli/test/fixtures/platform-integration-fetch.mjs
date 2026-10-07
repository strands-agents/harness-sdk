const originalFetch = globalThis.fetch

globalThis.fetch = (input, init) => {
  if (String(input) === 'https://skills.example.test/SKILL.md') {
    return Promise.resolve(
      new globalThis.Response(
        '---\nname: remote-platform-skill\ndescription: Remote platform integration marker.\n---\nUse remote-platform-skill.\n',
        { status: 200 }
      )
    )
  }
  return originalFetch(input, init)
}
