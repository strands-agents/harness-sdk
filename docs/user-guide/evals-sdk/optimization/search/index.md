The search is the part of an optimization run that proposes new configurations. Each **proposer** owns some of your tunable values and suggests new ones for them; the optimizer scores what they propose and tells them how it went. The defaults work for most runs. This page is for when you want a different proposer for a value, or a different model rewriting your text.

## What the search does by default

With no search given, every tunable value goes to a proposer by its kind:

| Values | Proposer | How it proposes |
| --- | --- | --- |
| Text: prompts, files, skills, tool descriptions | `Reflection` | A model (Claude Sonnet 5.5 on Amazon Bedrock) reads the agent’s own conversations, the judge’s reasons, and every earlier version with its scores, then rewrites the text |
| A `choice()` between components | `TPE` | Bayesian optimization over the alternatives |
| Numbers and `OneOf` options | `TPE` | Bayesian optimization, learned separately under each alternative |

When the space has a `choice()`, the search works in rounds: each round tries an alternative, then tunes the rest of the values inside it.

## Use Thompson sampling for choices

`Thompson` is an alternative proposer for choices (a `choice()` between components, or a `OneOf`). Instead of a separate search model, it samples each option’s effect from the optimizer’s own fit of everything measured so far, and proposes the untried option that looks best in that sample. Once every option is measured, the draw picks which one the search keeps refining, so it suits a few alternatives you want compared fairly, such as two models. It’s never the default: give it a block.

```python
from strands import Agent
from strands.models import BedrockModel
from strands_evals.optimization import (
    Block,
    Float,
    Search,
    TextValue,
    Thompson,
    choice,
    component,
    tunable,
)


@tunable(
    system_prompt=TextValue(),
    model=choice(
        haiku=component(
            BedrockModel,
            model_id="us.anthropic.claude-haiku-4-5-20251001-v1:0",
            temperature=Float(0.0, 1.0, default=0.3),
        ),
        sonnet=component(
            BedrockModel,
            model_id="us.anthropic.claude-sonnet-4-5-20250929-v1:0",
            temperature=Float(0.0, 1.0, default=0.3),
        ),
    ),
)
def create_agent(system_prompt="You are a support agent for Acme Shop.", model=None):
    return Agent(model=model, system_prompt=system_prompt, callback_handler=None)


search = Search([Block(Thompson(), "model")])
```

Pass it as `Optimizer(experiment, create_agent, search=search)`. Only the values a block names change hands: here Thompson picks the model, and each model’s temperature and the system prompt keep their default proposers.

With a combined objective (a weighted sum or a Pareto front), Thompson weighs the goals at random on each sample, so successive proposals aim at different trade-offs. Pass `random_weights=False` to aim every sample at the weights you declared.

## Change the text rewriter’s model

The default rewriter calls Claude Sonnet 5.5 on Amazon Bedrock. To use another model, give the text values a block of their own with a configured `Reflection`:

```python
from strands.models import BedrockModel
from strands_evals.optimization import Block, Reflection, Search

rewriter = Reflection(
    model=BedrockModel(model_id="us.anthropic.claude-sonnet-4-5-20250929-v1:0")
)
search = Search([Block(rewriter, "system_prompt")])
```

From the command line, `--reflection-model MODEL_ID` does the same for every text value.

The rewriter works through a shell confined to a temporary folder. That shell isn’t a sandbox: it can reach the network and anything the user running the optimizer can read. Run it on a machine or container without credentials it doesn’t need.

## Set the search from the command line

Every route takes `--search MODULE:ATTR`, naming a `Search` in your own module:

```bash
strands-evals optimize run experiment.json --agent agent.py:create_agent \
  --search tuning.py:search
```

`--search` and `--reflection-model` can’t be combined; set the model on the `Reflection` in your `Search` instead.

## Next steps

-   [Declaring what can change](/docs/user-guide/evals-sdk/optimization/tunables/index.md): The values a block can name
-   [Objectives, constraints, and budget](/docs/user-guide/evals-sdk/optimization/objectives/index.md): The goals Thompson samples against
-   [Reading the results](/docs/user-guide/evals-sdk/optimization/results/index.md): See which proposer produced the champion