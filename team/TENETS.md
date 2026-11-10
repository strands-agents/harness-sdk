# Development Tenets

Our team follows these core principles when designing and implementing features. These tenets help us make consistent decisions, resolve trade-offs, and maintain the quality and coherence of the SDK. When contributing, please consider how your changes align with these principles:

1. **Simple at any scale:** We believe that simple things should be simple. The same clean abstractions that power a weekend prototype should scale effortlessly to production workloads. We reject the notion that enterprise-grade means enterprise-complicated - Strands remains approachable whether it's your first agent or your millionth.
2. **Extensible by design:** We allow for as much configuration as possible, from hooks to model providers, session managers, tools, etc. We meet customers where they are with flexible extension points that are simple to integrate with.
3. **Composability:** Primitives are building blocks with each other. Each feature of Strands is developed with all other features in mind, they are consistent and complement one another.
4. **The obvious path is the happy path:** Through intuitive naming, helpful error messages, and thoughtful API design, we guide developers toward correct patterns and away from common pitfalls.
5. **We are accessible to humans and agents:** Strands is designed for both humans and AI to understand equally well. We don't take shortcuts on curated DX for humans and we go the extra mile to make sure coding assistants can help you use those interfaces the right way.
6. **Embrace common standards:** We respect what came before, and do not want to reinvent something that is already widely adopted or done better.

When proposing solutions or reviewing code, we reference these principles to guide our decisions. If two approaches seem equally valid, we choose the one that best aligns with our tenets.
