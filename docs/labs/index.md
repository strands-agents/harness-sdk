[Strands Labs](https://github.com/strands-labs) is the experimental arm of Strands Agents: open source projects that take the core SDK into new problem spaces. Where the SDK gives you the agent loop, tool use, model providers, and multi-agent patterns, Labs applies that foundation to areas like physical robotics, world models, agentic benchmarking, harness optimization, real-time audio, and fast decision models.

Labs projects are published to package repositories and work alongside the SDK today. They move faster and cover more surface area than the core SDK, so expect more frequent changes and newer integrations. Some projects graduate into the core SDK or become standalone products; others stay experimental. Each project lives in its own repository under the [strands-labs](https://github.com/strands-labs) organization.

## Projects

[Robots](https://github.com/strands-labs/robots)Control, simulate, and train physical robots with natural language. One Robot() call returns a MuJoCo simulation or real hardware, with pluggable vision-language-action policies and a peer-to-peer mesh.

[Strands for Cosmos](https://github.com/strands-labs/strands-for-cosmos)Bring NVIDIA Cosmos to Strands Agents: physics-aware reasoning over video, plus generation of video, audio, and robot actions on local compute.

[Benchmark Harnesses](https://github.com/strands-labs/benchmark-harnesses)Strands-based agents and harnesses for agentic benchmarks, including Simple Strands Agent, a lean autonomous-coding harness with strong results on SWE-Bench and Terminal Bench 2.

[Harness Optimizer](https://github.com/strands-labs/harness-optimizer)Optimize an agent's harness through tunable Formulas, then improve those Formulas from collected rollout trajectories with a PyTorch-style training loop.

[AI Functions](https://github.com/strands-labs/ai-functions)Python functions evaluated by AI agents. Enforce correctness with runtime post-conditions instead of prompt engineering alone, and compose functions into multi-agent workflows.

[PyWebRTC Audio](https://github.com/strands-labs/pywebrtc-audio)Python bindings for WebRTC audio processing: echo cancellation, noise suppression, gain control, and voice activity detection, with a working Strands BidiAgent integration.

[Strands Decider](strands-decider/index.md)A small, fast decision model, or system one model, for agentic workflows. Pick between options or rate on a scale faster than an LLM, with a calibrated confidence on every decision.

## Contributing

Have an experimental idea for AI agents? Labs takes contributions from across the community. See the [contributing guide](https://github.com/strands-agents/harness-sdk/blob/main/CONTRIBUTING.md) to get started.