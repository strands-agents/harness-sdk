import json
import os
import sys
import threading
import time

DESCRIPTION = json.loads(os.environ.get("FAKE_RUNNER_DESCRIPTION", "{}"))
LOG = os.environ.get("FAKE_RUNNER_LOG")
MODE = os.environ.get("FAKE_RUNNER_MODE", "")
ECHO = bool(os.environ.get("FAKE_RUNNER_ECHO"))
USAGE = {"inputTokens": 10, "outputTokens": 2, "totalTokens": 12}
WRITE = threading.Lock()
retried: set[str] = set()
first_run = threading.Event()


def log(request):
    if LOG:
        with WRITE, open(LOG, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(request) + "\n")


def run_reply(request):
    effort = request["values"].get("effort", DESCRIPTION.get("effort", "auto"))
    output = f"effort {effort} for {request['input']}" if ECHO else f"effort {effort}"
    messages = [
        {"role": "user", "content": [{"text": str(request["input"])}]},
        {"role": "assistant", "content": [{"text": output}]},
    ]
    if MODE == "error" and request["input"] == "question 0":
        return {"error": "the model refused", "messages": messages, "usage": USAGE, "cycles": 1}
    if MODE == "retryable" and request["input"] == "question 0" and "question 0" not in retried:
        retried.add("question 0")
        return {"error": "throttled", "retryable": True, "messages": [], "usage": {}, "cycles": 0}
    return {"output": output, "messages": messages, "usage": USAGE, "cycles": 1}


def reply_to(request):
    kind = request["type"]
    if kind == "describe":
        return DESCRIPTION
    if kind == "probe":
        return {"ok": request["values"].get("effort") != "max"}
    return run_reply(request)


def answer(request):
    if MODE == "delayed" and request["type"] == "run" and not first_run.is_set():
        first_run.set()
        time.sleep(0.3)
    reply = {"id": request["id"], **reply_to(request)}
    with WRITE:
        sys.stdout.write(json.dumps(reply) + "\n")
        sys.stdout.flush()


for line in sys.stdin:
    request = json.loads(line)
    log(request)
    if request["type"] == "cancel":
        continue
    if MODE == "exit" and request["type"] == "run":
        sys.exit(9)
    sys.stderr.write("noise from the agent module\n")
    threading.Thread(target=answer, args=(request,)).start()
