"""Prepare private Apps Script files without uploading anything."""

import json
import os
import tempfile
from pathlib import Path
from zoneinfo import ZoneInfo


def write_private(file, content):
    """Replace one artifact atomically without following an existing file link."""
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=file.parent,
                                         prefix=".prepare-", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, file)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main():
    root = Path(__file__).resolve().parent.parent
    config = json.loads((root / "config.local.json").read_text())
    ZoneInfo(config["timeZone"])
    manifest = json.loads((root / "appsscript.json").read_text())
    manifest["timeZone"] = config["timeZone"]
    os.umask(0o077)
    output = root / "build"
    if output.is_symlink():
        raise SystemExit("Refusing symlinked build directory.")
    output.mkdir(mode=0o700, exist_ok=True)
    output.chmod(0o700)
    targets = [output / name for name in ("Code.gs", "Config.gs", "appsscript.json")]
    if any(file.is_symlink() for file in targets):
        raise SystemExit("Refusing symlinked generated file.")
    write_private(output / "Code.gs", (root / "Code.js").read_text())
    write_private(output / "appsscript.json", json.dumps(manifest, indent=2) + "\n")
    write_private(output / "Config.gs",
        "// Private installation configuration. Never publish this file.\n"
        "function getInstallationConfig() {\n  return "
        + json.dumps(config, indent=2)
        + ";\n}\n"
    )
    print("Prepared build/Code.gs, build/Config.gs and build/appsscript.json. No upload.")


if __name__ == "__main__":
    main()
