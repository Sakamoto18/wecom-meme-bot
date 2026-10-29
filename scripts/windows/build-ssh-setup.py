#!/usr/bin/env python3
"""Package the SSH bootstrap and a validated PUBLIC key, never a private key."""

import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import struct
import zipfile


def public_fingerprint(contents: bytes) -> str:
    try:
        text = contents.decode("ascii").strip()
        match = re.fullmatch(r"ssh-ed25519 ([A-Za-z0-9+/=]+)(?: [^\r\n]+)?", text)
        if not match:
            raise ValueError
        blob = base64.b64decode(match[1], validate=True)
        prefix = struct.pack(">I", 11) + b"ssh-ed25519" + struct.pack(">I", 32)
        if len(blob) != len(prefix) + 32 or not blob.startswith(prefix):
            raise ValueError
    except (ValueError, UnicodeError):
        raise ValueError("Expected one OpenSSH Ed25519 public key; refusing other content.") from None
    digest = base64.b64encode(hashlib.sha256(blob).digest()).decode().rstrip("=")
    return "SHA256:" + digest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--public-key", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if args.public_key.suffix != ".pub":
        parser.error("--public-key must name a .pub file")
    if args.output.suffix != ".zip" or not re.fullmatch(r"[A-Za-z0-9_-]+", args.output.stem):
        parser.error("--output must be a .zip filename with letters, digits, underscores or hyphens")
    key = args.public_key.read_bytes()
    try:
        fingerprint = public_fingerprint(key)
    except ValueError as error:
        parser.error(str(error))
    script = Path(__file__).with_name("enable-ssh.ps1").read_bytes()
    manifest = {
        "scriptSha256": hashlib.sha256(script).hexdigest(),
        "publicKeySha256": hashlib.sha256(key).hexdigest(),
        "publicKeyFingerprint": fingerprint,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(args.output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        prefix = args.output.stem + "/"
        archive.writestr(prefix + "enable.ps1", script)
        archive.writestr(prefix + "deploy-key.pub", key)
        archive.writestr(prefix + "SSH-SETUP.json", json.dumps(manifest, indent=2) + "\n")
    digest = hashlib.sha256(args.output.read_bytes()).hexdigest()
    args.output.with_suffix(".zip.sha256").write_text(f"{digest}  {args.output.name}\n")
    print(f"Package: {args.output}")
    print(f"Public key fingerprint: {fingerprint}")
    print(f"SHA256: {digest}")


if __name__ == "__main__":
    main()
