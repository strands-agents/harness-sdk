from strands_harness import HARNESS_CONTRACT, build_system_prompt


def test_contract_only_by_default():
    assert build_system_prompt() == HARNESS_CONTRACT


def test_instructions_appended_after_contract():
    prompt = build_system_prompt("You are a SQL assistant.")
    assert prompt.startswith(HARNESS_CONTRACT)
    assert prompt.endswith("You are a SQL assistant.")


def test_context_parts_appended_last():
    prompt = build_system_prompt("domain block", ["Region: eu-west-1", "Repo: acme"])
    assert prompt.index("domain block") < prompt.index("Region: eu-west-1")
    assert prompt.index("Region: eu-west-1") < prompt.index("Repo: acme")
