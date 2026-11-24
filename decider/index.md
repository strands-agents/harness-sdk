# Strands Decider

`/decider`

_Strands Labs · Experimental_

Strands Decider is a System One model for repeated decisions. It scores a known output space (Choice, Yes / no, or Score) and returns a typed answer with calibrated confidence instead of generated text. These examples use recorded E2B output; results can vary slightly by device.

- [Run your first decision](https://strandsagents.com/docs/labs/strands-decider/quickstart/)
- [Compare models](https://strandsagents.com/docs/labs/strands-decider/models/)
- [View Decider on GitHub](https://github.com/strands-labs/strands-decider)

## Install and ask

Decider requires Python 3.11 or later.

```sh
pip install strands-decider
strands-decider ask StrandsAgents/strands-decider-E2B-gemma4-v2-2611 \
  --state "Help! My payouts have been failing for 3 days!" \
  --choice "Which team should handle this?=billing,sales,retail" \
  --noul "Does this convey urgency?" \
  --score "How frustrated is the writer?=calm,frustrated,depressed"
```

The recorded combined example returns:

- Choice: `billing` (confidence `0.659`)
  - `billing`: 0.773
  - `sales`: 0.121
  - `retail`: 0.106
- Noul: `0.858`
- Score: `1.03` (confidence `0.509`)
  - `0: calm`: 0.196
  - `1: frustrated`: 0.574
  - `2: depressed`: 0.230

These recorded outputs are illustrative. Results can vary slightly by device, and you should validate accuracy and thresholds on your own traffic.

## Answer shapes

- **Choice** (`choice`): Returns one option, a probability for each option, and confidence.
- **Yes / no** (`noul`): Returns the probability that the answer is yes. Your application sets the threshold.
- **Score** (`score`): Returns an expected level, the distribution over levels, and confidence.

## When Decider fits

Use Decider for repeated routing, classification, gating, or scoring when the possible answers are known before the request.

Keep a generative model when the result needs prose, code, a summary, an explanation, or multi-step reasoning.

- [Understand the boundary](https://strandsagents.com/docs/labs/strands-decider/introduction/)
- [Use bounded decisions with the Strands SDK](https://strandsagents.com/docs/user-guide/sdk/decision-models/)
- [Browse model weights](https://huggingface.co/StrandsAgents)

## Content

- [Introducing Strands Decider v2: open, calibrated system one models](https://strandsagents.com/blog/introducing-strands-decider-v2/) (Strands Blog, November 23, 2026): Strands Decider v2 launches with higher accuracy and better-calibrated confidence for making judgements with agents.
- [Bidirectional Attention, System One: Jonathan Buck](https://www.youtube.com/watch?v=dIt_CFbBwjU) (Video from AWS Developers, November 18, 2026, 39:07): Hear how bidirectional attention and System One models support fast, focused decisions without generating open-ended text.
- [Amazon saves millions by replacing Sonnet 4.6 with Strands Decider](https://strandsagents.com/blog/amazon-saves-millions-replacing-sonnet-with-strands-decider/) (Strands Blog, November 9, 2026): Two Amazon engineers swapped Claude Sonnet 4.6 for a decision model in one of the world's biggest internal ticketing systems.
