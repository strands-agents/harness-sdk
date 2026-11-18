Multi-Agent Specification and Resolution.

Provides the authority-mode system for model-driven multi-agent patterns, where the model configures child agents at runtime. The developer sets axis policies that shape the parameters the model sees and govern what values it can supply:

-   `Fixed` — developer-pinned value; hidden from the model.
-   `Inherit` — value taken from the parent agent; hidden from the model.
-   `Open` — model supplies a free-form value.
-   `Choice` — model picks from a developer-supplied set.

## Fixed

```python
@dataclass(frozen=True)
class Fixed()
```

Defined in: [src/strands/multiagent/spec.py:45](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/multiagent/spec.py#L45)

The developer pins the value; the axis contributes no model-facing parameter.

## Inherit

```python
@dataclass(frozen=True)
class Inherit()
```

Defined in: [src/strands/multiagent/spec.py:52](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/multiagent/spec.py#L52)

The child takes the parent’s value; the axis contributes no model-facing parameter.

## Open

```python
@dataclass(frozen=True)
class Open()
```

Defined in: [src/strands/multiagent/spec.py:57](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/multiagent/spec.py#L57)

The model writes the value freely; the axis contributes a string parameter.

## Option

```python
@dataclass(frozen=True)
class Option()
```

Defined in: [src/strands/multiagent/spec.py:62](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/multiagent/spec.py#L62)

A selectable entry in a `Choice`.

## Choice

```python
@dataclass(frozen=True)
class Choice()
```

Defined in: [src/strands/multiagent/spec.py:71](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/multiagent/spec.py#L71)

The model picks from a developer-supplied set.

Each entry is a bare name or an `Option`. Set `multiple=True` to let the model pick more than one.

#### normalized

```python
def normalized() -> list[Option]
```

Defined in: [src/strands/multiagent/spec.py:81](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/multiagent/spec.py#L81)

The options as `Option`s with `value` resolved, wrapping any bare name.

#### value\_for

```python
def value_for(name: str) -> Any
```

Defined in: [src/strands/multiagent/spec.py:93](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/multiagent/spec.py#L93)

The resolved value behind `name`, or `name` itself if unknown.

#### Axis

Any authority mode an axis can take.

## Preset

```python
@dataclass(frozen=True)
class Preset()
```

Defined in: [src/strands/multiagent/spec.py:106](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/multiagent/spec.py#L106)

A named role: a partially applied child configuration selected via `agent_type`.

## AgentSpec

```python
@dataclass
class AgentSpec()
```

Defined in: [src/strands/multiagent/spec.py:116](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/multiagent/spec.py#L116)

The resolved child configuration handed to the builder.