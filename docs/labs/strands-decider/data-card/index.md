Strands Decider is a decision model. It reads a state (the text that a decision is about) and a question, and it gives a probability for each option of the question. The v2 models are Gemma 4 base models, in five sizes from E2B to 31B, fine-tuned with the v2 recipes. This card describes the data mix of those recipes: how many rows it has, how the rows were made, what they are about, and what one row looks like. Use it to judge how close your own decisions are to the data that the models saw in training.

The counts of rows, tokens, options and kinds of source are exact, because a script read every row of the training file. The topic and the language of a row are estimates. [How this card was made](#how-this-card-was-made) gives the method.

## At a glance

|  |  |
| --- | --- |
| Rows | 17,480,970 |
| Input tokens | 8.87 billion |
| Kind of data | Text only |
| Written by language models | 72% of the rows |
| Generated in known task formats | 6% of the rows |
| From public datasets | 22% of the rows, from more than 200 datasets |
| Topics | 13 |
| Question types | `choice` (90%) and `noul` (10%) |
| Options for each question | 2 to 255 |
| Length of a row | Median 345 tokens, maximum 16,384 |
| Language | About 96% English |

## What one row is

One row is one decision. It has a state, a question, the options and the answer.

The state is the text that the decision is about, for example a document, a conversation, a record or a piece of code. The question says what to decide. A `choice` question lists 2 to 255 options, and the answer is one of them. A `noul` question is a yes/no question. In 0.6% of the rows, the answer gives a probability to more than one option.

[Sample rows](#sample-rows) has one row for each topic.

## How the rows were made

Language models wrote 72.1% of the rows. The other rows come from generator programs and from public datasets.

| Kind of source | Rows | Share | How the rows were made |
| --- | --- | --- | --- |
| Written by a language model: new tasks | 10,575,232 | 60.5% | A language model wrote the state, the question and the options from a task specification. |
| Written by a language model: tasks of existing datasets | 1,626,863 | 9.3% | A language model wrote new rows from the description of a task that a public dataset defines. |
| Written by a language model: rubric ratings | 409,091 | 2.3% | Long rows with a rubric and a response. The answer is the rating of the response under the rubric. These rows are part of the topic “Judging against rubrics, rules and policies”. |
| Generated in known task formats | 993,241 | 5.7% | Rows from generator programs, and rows built in the format of known task types, such as reasoning problems, commands for home devices and task dialogues. |
| Public datasets | 3,876,543 | 22.2% | Rows from published datasets, converted to the decision format. |

## What the rows are about

The rows cover 13 topics. No topic has more than 13% of the rows. The last line of the table holds the 0.4% of the rows that have no topic.

| Topic | What it covers | Share |
| --- | --- | --- |
| Knowledge and subject domains | Questions on science, medicine, law, finance, news and general knowledge | 12.1% |
| Judging against rubrics, rules and policies | Rate or compare responses, or apply a stated rule or policy to a case | 11.5% |
| Reasoning, math and puzzles | Logic, arithmetic, causal questions, games and puzzles | 11.2% |
| Reading, retrieval and grounding | Answer from a passage, judge relevance, check that an answer is supported | 10.5% |
| Sentiment, opinion and social | Opinions in reviews, sarcasm, stance, social situations | 9.6% |
| Safety, security and moderation | Unsafe requests, policy violations, phishing, offensive content, personal data | 8.2% |
| Tools, agents and devices | Choose a tool or an action, decide when not to act, control devices | 7.6% |
| Fact checking and entailment | Decide if evidence supports, contradicts or does not address a claim | 7.4% |
| Arts, culture and creative work | Art, literature, poems, music and color preferences | 7.1% |
| Language and linguistics | Meaning of sentences, grammar, entities, discourse | 5.3% |
| Customer service, commerce and intents | Intent of a request, dialogue state, product categories | 3.4% |
| Abstention | Questions where the correct answer can be “I don’t know” | 2.9% |
| Code | Predict what a piece of code returns | 2.8% |
| Other or mixed | Small sources that the rules did not place | 0.4% |

The kinds of source differ from topic to topic. The table gives, for each topic, the share of its rows from each kind.

| Topic | Rows | Written by language models | Generated in known formats | Public datasets |
| --- | --- | --- | --- | --- |
| Knowledge and subject domains | 2,117,960 | 65% | 3% | 33% |
| Judging against rubrics, rules and policies | 2,006,492 | 92% | 0% | 8% |
| Reasoning, math and puzzles | 1,955,160 | 62% | 26% | 12% |
| Reading, retrieval and grounding | 1,835,987 | 66% | 2% | 32% |
| Sentiment, opinion and social | 1,677,155 | 86% | 4% | 10% |
| Safety, security and moderation | 1,437,423 | 74% | 2% | 24% |
| Tools, agents and devices | 1,332,720 | 80% | 10% | 11% |
| Fact checking and entailment | 1,297,252 | 48% | 3% | 49% |
| Arts, culture and creative work | 1,243,295 | 89% | 2% | 9% |
| Language and linguistics | 927,672 | 75% | 1% | 24% |
| Customer service, commerce and intents | 586,362 | 14% | 13% | 73% |
| Abstention | 509,322 | 100% | 0% | 0% |
| Code | 483,933 | 71% | 1% | 28% |
| Other or mixed | 70,237 | 57% | 7% | 36% |

## Shape of the rows

### Question types

90.3% of the rows are `choice` questions, and 9.7% are `noul` questions. The decision interface has a third question type, `score` (a level on an ordered scale). No row of the mix has that type.

### Options for each question

`noul` rows count as 2 options.

| Options | Rows | Share |
| --- | --- | --- |
| 2 | 5,953,541 | 34.1% |
| 3 | 2,074,222 | 11.9% |
| 4 | 3,092,318 | 17.7% |
| 5 | 1,829,225 | 10.5% |
| 6 to 10 | 3,152,157 | 18.0% |
| 11 to 20 | 656,435 | 3.8% |
| 21 to 50 | 478,870 | 2.7% |
| 51 to 255 | 244,202 | 1.4% |

### Length of a row

Half of the rows are shorter than 345 tokens, and 99% are shorter than 4,096 tokens. The v2 training configs read at most 16,384 tokens of a row, and no row of the file is longer.

| Tokens | Rows | Share |
| --- | --- | --- |
| Up to 128 | 796,081 | 4.6% |
| 129 to 256 | 5,564,176 | 31.8% |
| 257 to 512 | 6,824,472 | 39.0% |
| 513 to 1,024 | 2,693,233 | 15.4% |
| 1,025 to 2,048 | 1,036,903 | 5.9% |
| 2,049 to 4,096 | 413,840 | 2.4% |
| 4,097 to 8,192 | 151,534 | 0.87% |
| 8,193 to 16,384 | 731 | under 0.01% |

### Language

| Language group | Share |
| --- | --- |
| English | 95.9% |
| Chinese, Japanese or Korean | 2.9% |
| Other languages in Latin script | 0.73% |
| Cyrillic script | 0.23% |
| Arabic or Hebrew script | 0.14% |
| Indic scripts | 0.10% |

## Sample rows

One row for each topic. Each sample is a row of the training file that a language model wrote as a new task. The state is shortened here, and the answer is left out.

Knowledge and subject domains

> **State:** Sensor dynamics firm Nordvane, a merchant buyer, faxes a purchase order to Halloran Components, a merchant seller, for 1,000 industrial pressure sensors at $85 each, delivery in three roughly equal monthly installments. The order’s reverse side carries Nordva…
> 
> **Question:** Under the UCC, which statement most accurately describes the parties’ rights and obligations in this dispute?
> 
> **Options:** (1) The clause did not become part of the contract, and because this is a…; (2) The clause did not become part of the contract, but Nordvane’s revoca…; (3) The clause did not become part of the contract: an express remedy-lim…; (4) Because both parties are merchants and Nordvane read and filed the ac… … (10 options in total)

Judging against rubrics, rules and policies

> **State:** A reagent supplier, Helvar Biologicals, files its monthly payment report. Its rules state: (1) flag any single payment over $9,500 made in cash or cash equivalents; (2) flag any set of payments from one client that together exceed $9,500 within 48 hours if st…
> 
> **Question:** Under the stated rules, how should Helvar treat the 14 March payments from NovaGene Labs?
> 
> **Options:** (1) Suspicious: the three payments total $10,200 from one client within 2…; (2) Suspicious under the structuring rule, because the client split one p…; (3) Suspicious: the memo on the $2,900 payment matches its invoice for ge…; (4) Not suspicious: the payments are non-cash bank transfers and no singl…

Reasoning, math and puzzles

> **State:** {“question”: “Omar makes 9 beads an hour and works 3 hours a day for 4 days. At the end, 3 of them turn out to be damaged and are thrown away. How many good beads does Omar have?”, “task”: “a word problem with one numeric answer”}
> 
> **Question:** Which option is the answer to the problem?
> 
> **Options:** (1) 108; (2) 111; (3) 45; (4) 105

Reading, retrieval and grounding

> **State:** {“passage”: “Brennan Marsh Edges Ferrers in Dramatic Finish at the Kingsway Velodrome\\n\\nBrennan Marsh of Team Aldergrove won the 34th Kingsway Criterium on Sunday, out-sprinting Noor Ferrers of the Crandall Track Club by half a wheel at the line after 96 lap…
> 
> **Question:** Does the answer state anything the passage does not support?
> 
> **Options:** (1) Every claim in the answer is supported by the passage.; (2) The answer contains at least one unsupported or contradicted claim.

Sentiment, opinion and social

> **State:** Passage: This has been a bruising season for carriers in the Mountain West corridor. Cascade Skyways said load factors slid to 71% after it cut two regional routes, and Aurora Jetlink disclosed that its maintenance backlog pushed it to trim its autumn schedul…
> 
> **Question:** What sentiment does the passage express toward the named company?
> 
> **Options:** (1) positive; (2) neutral; (3) negative

Safety, security and moderation

> **State:** Conversation between a user and an engineering assistant, under a policy that forbids instructions for bypassing safety-critical engineering safeguards or operating equipment beyond certified limits. Turn 1: “I’m studying for my PE exam. Can you walk me throu…
> 
> **Question:** Under the stated policy, at which turn does the conversation first cross into a disallowed request?
> 
> **Options:** (1) Turn 1; (2) Turn 2; (3) Neither turn crosses the policy

Tools, agents and devices

> **State:** {“tools”: \[{“name”: “get\_balance”, “description”: “Return the current balance of an account.”, “parameters”: {“type”: “object”, “properties”: {“account\_number”: {“type”: “string”}}, “required”: \[“account\_number”\]}}, {“name”: “block\_card”, “description”: “Imme…
> 
> **Question:** Given the tools on offer, which reply should the assistant send?
> 
> **Options:** (1) {“name”: “block\_card”, “arguments”: {“card\_id”: “CRD-77321”, “reason”…; (2) Which restaurant did you leave it at, and do you want me to block it…; (3) Don’t worry, the card is now blocked and no further charges can go th…; (4) {“name”: “block\_card”, “arguments”: {“card\_id”: “CRD-77321”, “reason”…

Fact checking and entailment

> **State:** Document 1: Glasswind Cantos Glasswind Cantos is a lyric novel published in 1972 by the poet Davan Orel. Structured as twelve interlocking cantos, it follows a lighthouse keeper who collects the letters of strangers. Critics credit the book with reviving vers…
> 
> **Question:** Do the documents support the claim?
> 
> **Options:** (1) supported; (2) not supported

Arts, culture and creative work

> **State:** In 1904, the civic board of a mid-sized river town commissioned planner Edmund Vasek to reshape its core. Vasek’s proposal, the ‘Meridian Plan’, replaces a tangle of dockside lanes with a single triumphal avenue cut diagonally to the riverfront, terminated by…
> 
> **Question:** Which art movement or planning style does the described Meridian Plan belong to?
> 
> **Options:** (1) The City Beautiful movement; (2) Art Deco; (3) The International Style; (4) The Bauhaus school … (8 options in total)

Language and linguistics

> **State:** {“sentence”: “The masterclass on partimenti by the old maestro Fenzi’s last living assistant ended in a shouting match over figured bass.”, “context”: {“source”: “Conservatory bulletin, spring term”, “program\_note”: “Masterclass leader: Sigr. A. Lotti, former…
> 
> **Question:** Which reading of the sentence does the bulletin’s context force?
> 
> **Options:** (1) Lotti taught the masterclass using partimenti he himself had composed.; (2) The partimenti were composed by Lotti, and the shouting match was sta…; (3) The masterclass was taught by Fenzi, and the shouting match concerned…; (4) Fenzi taught the masterclass using his own partimenti, with Lotti mer… … (9 options in total)

Customer service, commerce and intents

> **State:** User request: hey what stuff am I supposed to get done today again?
> 
> **Question:** Which intent does the user’s request express? Choose out\_of\_scope if it fits none of them.
> 
> **Options:** (1) check\_balance; (2) transfer\_funds; (3) recent\_transactions; (4) freeze\_account … (151 options in total)

Abstention

> **State:** A geneticist is reviewing a family with an autosomal recessive hearing-loss syndrome. Two siblings are affected: one carries a missense variant in the gene on one chromosome and a nonsense variant in the same gene on the other chromosome; both parents are una…
> 
> **Question:** Which option is the right answer? If you do not know it, pick “I don’t know”.
> 
> **Options:** (1) Double heterozygosity in trans linkage; (2) Homozygous recessive inheritance; (3) Compound heterozygosity; (4) Pseudoallelic complementation … (5 options in total)

Code

> **State:** {“code”: “def f(s):\\n s = s.upper()\\n s = s\[3:\] + s\[:3\]\\n return s”, “input”: “‘tea sea salt’”, “task”: “the return value of a function”}
> 
> **Question:** Select the exact return value of f on this input.
> 
> **Options:** (1) ‘ALTTEA SEA S’; (2) ’ SEA SALTTEA’; (3) ‘TEA SEA SALT’; (4) ’ sea salttea’

## Limits of the data

About 96% of the rows are in English, so the data gives little evidence on other languages. Long inputs are rare: 99% of the rows are shorter than 4,096 tokens.

Language models wrote 72% of the rows, so the data carries the style of those models.

The safety topic has rows with offensive or unsafe text, because the task is to recognise such text.

The shares of the topics come from how the data was built. They are not the shares of topics in real use.

## How this card was made

A script read every row of the training file and counted 17,480,970 rows.

Each row records the part of the training set that it belongs to, and each part is one kind of source. Each row also records its source, which is one public dataset or one set of generated tasks. The file has 758 sources.

Each source has one topic. We set the topic by hand for the 150 largest sources, which hold 82% of the rows. Keyword rules on the name of the source and on one sample question set the topic of the other sources. 0.4% of the rows have no topic and are in “Other or mixed”.

Each row records its number of input tokens, and the lengths in this card are those numbers.

The language is an estimate, not the result of a language detector. A script looked at the script of the first characters of the question and the state in a sample of 752,309 rows (4.3% of the rows). For Latin script, it looked for common English words.

Shares are rounded, so a column can add to a little more or less than 100%.

## Where to go next

-   [Training a Decider model](/docs/labs/strands-decider/training/index.md): the training recipes.
-   [Models](/docs/labs/strands-decider/models/index.md): the released models.

Card version: 2026-11-19.