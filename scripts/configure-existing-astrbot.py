#!/usr/bin/env python3
"""Configure the QQ backend and bridge plugin for an existing AstrBot stack."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import secrets


PLACEHOLDER_PREFIXES = ("请替换", "replace-me")


def read_env(lines: list[str]) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def replace_env_value(lines: list[str], key: str, value: str) -> list[str]:
    prefix = f"{key}="
    replaced = False
    result: list[str] = []
    for line in lines:
        if line.startswith(prefix):
            result.append(prefix + value)
            replaced = True
        else:
            result.append(line)
    if not replaced:
        result.append(prefix + value)
    return result


def write_private_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(content, encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(path)


def configure_env(env_file: Path, example_file: Path) -> str:
    if env_file.exists():
        lines = env_file.read_text(encoding="utf-8").splitlines()
    else:
        lines = example_file.read_text(encoding="utf-8").splitlines()

    values = read_env(lines)
    token = values.get("QQ_API_TOKEN", "")
    if not token or token.startswith(PLACEHOLDER_PREFIXES):
        token = secrets.token_hex(32)
        lines = replace_env_value(lines, "QQ_API_TOKEN", token)

    write_private_text(env_file, "\n".join(lines).rstrip() + "\n")
    return token


def configure_plugin(astrbot_data: Path, token: str) -> Path:
    config_path = (
        astrbot_data
        / "config"
        / "astrbot_plugin_longtu_bridge_config.json"
    )
    if config_path.exists():
        try:
            config = json.loads(config_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            config = {}
    else:
        config = {}

    config.update({
        "api_url": "http://qq-bot:8787/v1/qq/message",
        "api_token": token,
    })
    config.setdefault("allowed_groups", "")
    config.setdefault("reply_only_when_waked", True)
    config.setdefault("send_processing_hint", False)
    config.setdefault("request_timeout_seconds", 190)
    config.setdefault("error_message", "龙图服务暂时不可用，请稍后再试。")
    write_private_text(
        config_path,
        json.dumps(config, ensure_ascii=False, indent=2) + "\n",
    )
    return config_path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--example-file", type=Path, required=True)
    parser.add_argument("--astrbot-data", type=Path, required=True)
    args = parser.parse_args()

    token = configure_env(args.env_file, args.example_file)
    config_path = configure_plugin(args.astrbot_data, token)
    print(f"Configured backend environment: {args.env_file}")
    print(f"Configured AstrBot bridge: {config_path}")


if __name__ == "__main__":
    main()
