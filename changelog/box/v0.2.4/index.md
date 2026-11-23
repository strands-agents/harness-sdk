# Box v0.2.4

Released 2026-11-19
Release: https://github.com/strands-agents/box/releases/tag/v0.2.4 · Package: https://github.com/strands-agents/box/releases/tag/v0.2.4

## Features
- send box telemetry to Langfuse, LangSmith and CloudWatch (https://github.com/strands-agents/box/pull/314)
- add monty = false, so a bare python3 resolves like any other program (https://github.com/strands-agents/box/pull/444)
- upgrade Dogwood to 1.1.2 with fresh history (https://github.com/strands-agents/box/pull/422)
- raise the default Shell stdin and output limits to 1 MiB (https://github.com/strands-agents/box/pull/498)
- activate Linux native filesystem policy (https://github.com/strands-agents/box/pull/188)
- leave out a tool whose program is not installed (https://github.com/strands-agents/box/pull/490)
- deny writes to a directory inside a write grant, in every process (https://github.com/strands-agents/box/pull/429)
- read a secret from a declared host program (https://github.com/strands-agents/box/pull/489)
- load, check, and store a secret source declaration (https://github.com/strands-agents/box/pull/499)
- read each declared secret at startup and deliver it (https://github.com/strands-agents/box/pull/500)
- keep the vault of a secret source from each workload (https://github.com/strands-agents/box/pull/501)
- remove the Linux x86-64 startup opt-in (https://github.com/strands-agents/box/pull/523)

## Fixes
- permit fchdir in the Linux workload filter (https://github.com/strands-agents/box/pull/483)
- state the full FSEvents reach in the file-watching warning (https://github.com/strands-agents/box/pull/484)
- pick up upstream touch and decide its time change by policy (https://github.com/strands-agents/box/pull/471)
- verify approved directories during Linux sandbox launch (https://github.com/strands-agents/box/pull/264)
- keep a mixed-namespace rule from being dropped when a catalog fails to stage (https://github.com/strands-agents/box/pull/469)
- close inherited descriptors in one syscall, not an RLIMIT\_NOFILE loop (https://github.com/strands-agents/box/pull/37)
- permit fork on Linux x86-64 (https://github.com/strands-agents/box/pull/510)
- say that a program installed during the run is not a tool (https://github.com/strands-agents/box/pull/492)
- grant a link from the lookup the run approved and its linked folders (https://github.com/strands-agents/box/pull/487)
- permit renameat2 with no flags or RENAME\_NOREPLACE on Linux (https://github.com/strands-agents/box/pull/511)
- let a box stat the macOS /tmp link (https://github.com/strands-agents/box/pull/519)
- copy the host's top-level links into /usr into the Linux view (https://github.com/strands-agents/box/pull/512)

## Other
- pin the transport of a plain-HTTP response through the real proxy (https://github.com/strands-agents/box/pull/478)
- bump Strands Shell to 39daa83 (https://github.com/strands-agents/box/pull/494)
- cover monty = false through ShellSpec and the python3 alias (https://github.com/strands-agents/box/pull/496)
- fix stale agent guidance and fragile checks ahead of a feature merge (https://github.com/strands-agents/box/pull/480)
- make a secret provider a plugin (https://github.com/strands-agents/box/pull/467)
- retry copied executable host controls (https://github.com/strands-agents/box/pull/509)
- state that max\_output bounds curl response bodies (https://github.com/strands-agents/box/pull/507)
- always publish Linux ARM64 and shorten input labels (https://github.com/strands-agents/box/pull/514)
- prove fchdir keeps folder permission and inherited-handle cleanup (https://github.com/strands-agents/box/pull/513)
- narrow decision-entry findings and add a test critic (https://github.com/strands-agents/box/pull/515)
- run the macOS deterministic suite in the unit-test job (https://github.com/strands-agents/box/pull/517)
- split the critics into a shared method and a Core area file (https://github.com/strands-agents/box/pull/521)
