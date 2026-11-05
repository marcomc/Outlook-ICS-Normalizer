"""Upload private prepared files using the current gws identity, never secret argv."""

import json
import os
import subprocess
import urllib.parse
import urllib.request
from pathlib import Path
from prepare import write_private


def main():
    root = Path(__file__).resolve().parent.parent
    config = json.loads((root / "config.local.json").read_text())
    status = json.loads(subprocess.run(["gws", "auth", "status"], check=True,
                                      capture_output=True, text=True).stdout)
    if status.get("user") != config.get("installationAccount"):
        raise SystemExit("gws identity does not match installationAccount.")
    state = root / ".installation.json"
    if state.is_symlink():
        raise SystemExit("Refusing linked installation state.")
    if not state.exists():
        descriptor = os.open(state, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as stream:
            json.dump({"scriptId": None, "account": status["user"]}, stream)
        result = subprocess.run(["gws", "script", "projects", "create", "--json",
                                 json.dumps({"title": "Outlook ICS Normalizer"})],
                                check=True, capture_output=True, text=True)
        script_id = json.loads(result.stdout)["scriptId"]
        write_private(state, json.dumps({"scriptId": script_id, "account": status["user"]}))
    saved = json.loads(state.read_text())
    if saved["account"] != status["user"]:
        raise SystemExit("Installation identity mismatch.")
    if not saved.get("scriptId"):
        raise SystemExit("Previous project creation is uncertain; reconcile it before retrying.")
    credentials = json.loads(subprocess.run(["gws", "auth", "export", "--unmasked"],
                                           check=True, capture_output=True, text=True).stdout)
    body = urllib.parse.urlencode({"grant_type": "refresh_token", **{
        key: credentials[key] for key in ("client_id", "client_secret", "refresh_token")}}).encode()
    with urllib.request.urlopen(urllib.request.Request("https://oauth2.googleapis.com/token", data=body)) as response:
        token = json.load(response)["access_token"]
    files = []
    for name in ("Code", "Sync", "Ical", "Config"):
        files.append({"name": name, "type": "SERVER_JS",
                      "source": (root / "build" / (name + ".gs")).read_text()})
    files.append({"name": "appsscript", "type": "JSON",
                  "source": (root / "build/appsscript.json").read_text()})
    endpoint = "https://script.googleapis.com/v1/projects/" + urllib.parse.quote(saved["scriptId"], safe="") + "/content"
    headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json"}
    request = urllib.request.Request(endpoint, data=json.dumps({"files": files}).encode(), headers=headers, method="PUT")
    with urllib.request.urlopen(request) as response:
        json.load(response)
    # Separate authoritative readback, not just an upload response.
    with urllib.request.urlopen(urllib.request.Request(endpoint, headers=headers)) as response:
        received = {f["name"]: f["source"] for f in json.load(response)["files"]}
    if received != {f["name"]: f["source"] for f in files}:
        raise SystemExit("Uploaded source did not match the prepared files.")
    print("Uploaded five private project files and verified exact source readback.")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        raise SystemExit("Upload failed; credentials and private source omitted. Inspect private installation state before retrying.") from None
