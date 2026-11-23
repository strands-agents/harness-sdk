# Box v0.3.0-preview.1

Released 2026-11-21
Release: https://github.com/strands-agents/box/releases/tag/v0.3.0-preview.1 · Package: https://github.com/strands-agents/box/releases/tag/v0.3.0-preview.1

## Features
- give a library caller each policy decision as it is made (https://github.com/strands-agents/box/pull/528)
- batch history writes by default (https://github.com/strands-agents/box/pull/400)
- write each grammar action input inline in the schema (https://github.com/strands-agents/box/pull/432)
- allow \`\_\`, uppercase letters, and a leading \`+\` in grammar command words (https://github.com/strands-agents/box/pull/423)
- record MCP tool calls for a target that names mcp\_tool\_calls (https://github.com/strands-agents/box/pull/463)
- load a declared secret source on Linux (https://github.com/strands-agents/box/pull/531)
- bump Strands Shell to 674212e and report the host's uname (https://github.com/strands-agents/box/pull/534)
- trust the host's root certificates for upstream TLS (https://github.com/strands-agents/box/pull/522)
- add host.box.internal that points to the host OS's loopback (https://github.com/strands-agents/box/pull/530)
- let the toolchain word of a grammar action carry effects (https://github.com/strands-agents/box/pull/427)
- add the box command-line tool (https://github.com/strands-agents/box/pull/555)
- let a grammar action take over an anywhere global option (https://github.com/strands-agents/box/pull/433)
- publish the box CLI with Box Core in one release (https://github.com/strands-agents/box/pull/566)

## Fixes
- allow executable memory on Linux so JIT runtimes run (https://github.com/strands-agents/box/pull/488)
- let policy alone decide the removal or replacement of a mount point (https://github.com/strands-agents/box/pull/503)
- keep the gateway's reason on a refused HTTPS tunnel (https://github.com/strands-agents/box/pull/526)
- let a contained process read kern.argmax (https://github.com/strands-agents/box/pull/532)
- make a file target's append uncancellable (https://github.com/strands-agents/box/pull/473)
- refuse an empty path, with Strands Shell 754a534 (https://github.com/strands-agents/box/pull/547)
- keep MCP argument names that are not Cedar identifiers (https://github.com/strands-agents/box/pull/505)
- answer a failed upstream exchange with a 502 that says why (https://github.com/strands-agents/box/pull/545)
- do not sign the headers that botocore does not sign (https://github.com/strands-agents/box/pull/537)
- keep box's forbids while policy is off, and gate Ctrl+\\ on a shown banner (https://github.com/strands-agents/box/pull/558)
- accept a pre-release box version in an engine floor (https://github.com/strands-agents/box/pull/561)
- refuse a link in any folder a box can write, and move copies by directory handle (https://github.com/strands-agents/box/pull/571)
- refuse a detected MCP server whose env points where the box can write (https://github.com/strands-agents/box/pull/572)
- sign the CLI with Box Core's macOS identity (https://github.com/strands-agents/box/pull/577)

## Other
- improve the reviewer bot (https://github.com/strands-agents/box/pull/535)
- cover native filesystem effects and policy history (https://github.com/strands-agents/box/pull/536)
- write prose in plain English, and take dashes out of the user and design pages (https://github.com/strands-agents/box/pull/540)
- test and publish Linux x86-64 packages by default (https://github.com/strands-agents/box/pull/541)
- restore blocking mode for shutdown fixture connections (https://github.com/strands-agents/box/pull/542)
- split Core unit tests in two halves and give macOS containment its own runner (https://github.com/strands-agents/box/pull/567)
- run the CLI's Linux tests for a Box Core change (https://github.com/strands-agents/box/pull/559)
