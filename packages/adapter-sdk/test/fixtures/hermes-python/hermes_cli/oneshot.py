import json
import time


def run_oneshot(prompt):
    if "BRIDGE_WAIT" in prompt:
        time.sleep(60)
    print("native log that the bridge must suppress")
    response = {
        "reply": "hermes bridge success",
        "messages": [],
        "status": "done",
        "retryable": False,
        "artifacts": [],
    }
    if "HERMES_HTTP_ERROR" in prompt:
        print("HTTP 503 upstream unavailable")
        return 0
    if "HERMES_RC_FAILURE" in prompt:
        print(json.dumps(response))
        return 7
    if "HERMES_MULTILINE" in prompt:
        print(json.dumps(response, indent=2))
        return 0
    if "HERMES_PLAIN" in prompt:
        print("hermes plain final")
        return 0
    print(json.dumps(response))
    return 0
