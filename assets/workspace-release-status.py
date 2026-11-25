#!/usr/bin/env python3
import argparse
import datetime
import json
import math
import os
import stat
import sys
import tempfile
from pathlib import Path

LIMIT = 65536
ROOT = Path("/home/dev/projects")
FIELDS = ("validated", "published", "deployed")


def parse(raw):
    if len(raw) > LIMIT:
        raise ValueError("Release report exceeds 64 KiB.")
    report = json.loads(raw)
    if not isinstance(report, dict) or set(report) != {"checkedAt", *FIELDS}:
        raise ValueError("Expected checkedAt, validated, published and deployed.")
    at = datetime.datetime.fromisoformat(report["checkedAt"].replace("Z", "+00:00"))
    if at.utcoffset() is None:
        raise ValueError("Observation time must include a timezone.")
    for name in FIELDS:
        if report[name] is not None and not isinstance(report[name], dict):
            raise ValueError(f"Expected a record or null for {name}.")
    pending = [(report, 0)]
    count = 0
    while pending:
        item, depth = pending.pop()
        count += 1
        if count > 150 or depth > 7:
            raise ValueError("Release report has too many fields or nesting levels.")
        if isinstance(item, dict):
            if any(not key or len(key) > 120 for key in item):
                raise ValueError("Invalid release field name.")
            pending.extend((value, depth + 1) for value in item.values())
        elif isinstance(item, list):
            pending.extend((value, depth + 1) for value in item)
        elif isinstance(item, float) and not math.isfinite(item):
            raise ValueError("Invalid number in release report.")
    return report


def read_project(project):
    parts = project.split("/")
    if any(p in ("", ".", "..") for p in parts):
        raise ValueError("Choose a directory relative to /home/dev/projects.")
    directory = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open(ROOT, directory)
    try:
        for part in [*parts, ".ai-workspace"]:
            child = os.open(part, directory, dir_fd=fd)
            os.close(fd)
            fd = child
        file = os.open("release-status.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        with os.fdopen(file, "rb") as stream:
            if not stat.S_ISREG(os.fstat(file).st_mode):
                raise ValueError("Expected a regular release report.")
            return parse(stream.read(LIMIT + 1))
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("save")
    commands.add_parser("show").add_argument("project")
    args = parser.parse_args()
    if args.command == "show":
        print(json.dumps(read_project(args.project), indent=2))
        return
    report = parse(sys.stdin.buffer.read(LIMIT + 1))
    cwd = Path.cwd()
    if not cwd.is_relative_to(ROOT) or cwd == ROOT:
        raise ValueError("Run save in a workspace-local project.")
    target = cwd / ".ai-workspace"
    target.mkdir(mode=0o700, exist_ok=True)
    if target.is_symlink():
        raise ValueError("The report directory must be local to the project.")
    with tempfile.NamedTemporaryFile(dir=target, delete=False) as stream:
        temp = Path(stream.name)
        try:
            encoded = json.dumps(report, ensure_ascii=False, separators=(",", ":")).encode()
            if len(encoded) > LIMIT:
                raise ValueError("Release report exceeds 64 KiB.")
            stream.write(encoded)
            stream.flush()
            os.replace(temp, target / "release-status.json")
        finally:
            temp.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        main()
    except (AttributeError, TypeError, ValueError, OSError, RecursionError) as error:
        sys.exit(str(error))
