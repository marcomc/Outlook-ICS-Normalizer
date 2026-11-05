"""Update an existing Apps Script installation, preserving private cloud config."""

import json
import os
import re
import subprocess
import urllib.parse
import urllib.request
from pathlib import Path


SCOPES = {"https://www.googleapis.com/auth/script.projects",
          "https://www.googleapis.com/auth/userinfo.email",
          "https://www.googleapis.com/auth/userinfo.profile", "openid"}


def request_json(url, token=None, data=None, method=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(url, headers=headers,
                                     data=None if data is None else json.dumps(data).encode(), method=method)
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def access_token(credentials):
    body = urllib.parse.urlencode({"grant_type": "refresh_token", **{
        key: credentials[key] for key in ("client_id", "client_secret", "refresh_token")}}).encode()
    with urllib.request.urlopen(urllib.request.Request("https://oauth2.googleapis.com/token", data=body), timeout=60) as response:
        result = json.load(response)
    # Reject accidentally handing a broad personal CLI refresh token to CI.
    granted = set(result["scope"].split())
    if not granted <= SCOPES or not {"https://www.googleapis.com/auth/script.projects",
                                          "https://www.googleapis.com/auth/userinfo.email"} <= granted:
        raise ValueError("Deployment authorization has unexpected scopes.")
    return result["access_token"]


def file_map(payload):
    files = payload["files"]
    if not isinstance(files, list) or len(files) != 5:
        raise ValueError("Unexpected installed file set.")
    expected = {"Code": "SERVER_JS", "Sync": "SERVER_JS", "Ical": "SERVER_JS",
                "Config": "SERVER_JS", "appsscript": "JSON"}
    result = {}
    for file in files:
        name = file["name"]
        if name in result or expected.get(name) != file["type"] or not isinstance(file["source"], str):
            raise ValueError("Unexpected installed file.")
        result[name] = {"name": name, "type": file["type"], "source": file["source"]}
    if set(result) != set(expected):
        raise ValueError("Missing installed file.")
    if "function getInstallationConfig()" not in result["Config"]["source"]:
        raise ValueError("Private installation configuration is missing.")
    return result


def current_revision(root, expected):
    if not expected or len(expected) != 40 or any(ch not in "0123456789abcdef" for ch in expected):
        raise ValueError("Expected an exact Git commit.")
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    if head != expected:
        raise ValueError("Checkout differs from requested revision.")
    if subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=normal"], cwd=root, text=True):
        raise ValueError("Deployment requires a clean checkout.")
    repository = os.environ["GITHUB_REPOSITORY"]
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError("Invalid GitHub repository identity.")
    origin = subprocess.check_output(["git", "remote", "get-url", "origin"], cwd=root, text=True).strip()
    if origin.removesuffix(".git").lower() != ("https://github.com/" + repository).lower():
        raise ValueError("Checkout repository identity mismatch.")
    latest = request_json("https://api.github.com/repos/" + repository + "/git/ref/heads/main",
                          os.environ["GITHUB_TOKEN"])
    if (latest.get("ref") != "refs/heads/main" or latest.get("object", {}).get("type") != "commit" or
            latest["object"].get("sha") != expected):
        raise ValueError("Stale deployment; remote main has advanced.")


def deploy(root, target, credentials, revision):
    current_revision(root, revision)
    token = access_token(credentials)
    identity = request_json("https://www.googleapis.com/oauth2/v2/userinfo", token)
    if identity.get("email") != target["account"] or identity.get("verified_email") is not True:
        raise ValueError("Deployment account mismatch.")
    project = "https://script.googleapis.com/v1/projects/" + urllib.parse.quote(target["scriptId"], safe="")
    metadata = request_json(project, token)
    if (metadata.get("scriptId") != target["scriptId"] or
            metadata.get("creator", {}).get("email") != target["account"]):
        raise ValueError("Installed project identity mismatch.")
    live = file_map(request_json(project + "/content", token))
    installed_manifest = json.loads(live["appsscript"]["source"])
    manifest = json.loads((root / "appsscript.json").read_text())
    if (set(manifest["oauthScopes"]) != set(installed_manifest["oauthScopes"]) or
            manifest.get("dependencies") != installed_manifest.get("dependencies")):
        raise ValueError("Permission/service changes require an owner-controlled update first.")
    manifest["timeZone"] = installed_manifest["timeZone"]
    candidate = dict(live)
    for name, source in (("Code", "Code.js"), ("Sync", "Sync.js"), ("Ical", "vendor/ical.js")):
        candidate[name] = {"name": name, "type": "SERVER_JS", "source": (root / source).read_text()}
    candidate["appsscript"] = {"name": "appsscript", "type": "JSON", "source": json.dumps(manifest, indent=2) + "\n"}
    # Recheck the remote head and private installation immediately before mutation.
    current_revision(root, revision)
    if request_json(project, token) != metadata:
        raise ValueError("Project metadata changed during deployment; no upload.")
    if file_map(request_json(project + "/content", token)) != live:
        raise ValueError("Installed source changed during deployment; no upload.")
    request_json(project + "/content", token, {"files": list(candidate.values())}, "PUT")
    if file_map(request_json(project + "/content", token)) != candidate:
        raise ValueError("Cloud readback differs; inspect installation before retrying.")
    # A version is an audit snapshot. Installable timers continue to use HEAD.
    request_json(project + "/versions", token, {"description": "Git " + revision}, "POST")
    print("Deployment verified for commit " + revision + "; private configuration preserved.")


def main():
    root = Path(__file__).resolve().parent.parent
    deploy(root, json.loads(os.environ["DEPLOY_TARGET_JSON"]),
           json.loads(os.environ["DEPLOY_AUTH_JSON"]), os.environ["DEPLOY_COMMIT_SHA"])


if __name__ == "__main__":
    try:
        main()
    except Exception:
        raise SystemExit("Deployment failed. Private configuration and credentials omitted; inspect the target before retrying.") from None
