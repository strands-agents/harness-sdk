from strands_harness import HARNESS_CONTRACT, build_system_prompt


def test_contract_only_by_default():
    assert build_system_prompt() == HARNESS_CONTRACT


def test_instructions_appended_after_contract():
    prompt = build_system_prompt("You are a SQL assistant.")
    assert prompt.startswith(HARNESS_CONTRACT)
    assert prompt.endswith("You are a SQL assistant.")


def test_context_parts_appended_last():
    prompt = build_system_prompt("domain block", ["Current time: noon", "Repo: acme"])
    assert prompt.index("domain block") < prompt.index("Current time: noon")
    assert prompt.index("Current time: noon") < prompt.index("Repo: acme")
