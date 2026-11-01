#!/usr/bin/env python3
"""Verify/apply a GitHub main-branch ruleset using the official REST API.

Safe by default: no network mutation unless --apply is explicitly selected.
Uses public metadata for --check. --apply requires GH_TOKEN with repository
Administration:write; never print or save tokens.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

REPOSITORY = "Ai-b0ss/atelier-telegram-shop"
NAME = "Atelier main — tested PRs only"
API = f"https://api.github.com/repos/{REPOSITORY}/rulesets"
POLICY = Path(__file__).resolve().parents[1] / ".github" / "main-ruleset.json"


def expected_policy():
    return json.loads(POLICY.read_text(encoding="utf-8"))


def rule_map(data):
    return {rule["type"]: rule for rule in data.get("rules", [])}


def issues(data, expected=None):
    """Return exactly what is wrong; never accept a merely named ruleset."""
    spec = expected or expected_policy()
    problems = []
    if data.get("name") != spec["name"]:
        problems.append("wrong ruleset name")
    if data.get("target") != "branch":
        problems.append("not a branch ruleset")
    if data.get("enforcement") != "active":
        problems.append("not enforced (active)")
    includes = data.get("conditions", {}).get("ref_name", {}).get("include", [])
    if "refs/heads/main" not in includes and "~DEFAULT_BRANCH" not in includes:
        problems.append("does not target main")
    if data.get("conditions", {}).get("ref_name", {}).get("exclude"):
        problems.append("unexpected branch exclusions")
    rules = rule_map(data)
    for required in ("deletion", "non_fast_forward", "pull_request", "required_status_checks"):
        if required not in rules:
            problems.append("missing " + required)
    pull = rules.get("pull_request", {}).get("parameters", {})
    if pull.get("required_approving_review_count", -1) < 0:
        problems.append("missing PR review-count configuration")
    if pull.get("required_review_thread_resolution") is not True:
        problems.append("unresolved review threads are permitted")
    status = rules.get("required_status_checks", {}).get("parameters", {})
    if status.get("strict_required_status_checks_policy") is not True:
        problems.append("checks are not strict/up-to-date")
    wanted = {x["context"] for x in rule_map(spec)["required_status_checks"]["parameters"]["required_status_checks"]}
    actual = {x.get("context") for x in status.get("required_status_checks", [])}
    for missing in sorted(wanted - actual):
        problems.append("missing required CI: " + missing)
    # GitHub hides bypass_actors from unauthenticated users. Validate them
    # only when the admin API explicitly provides that property.
    if data.get("bypass_actors"):
        problems.append("bypass actors are configured")
    return problems


def request(url, token=None, payload=None):
    headers = {"Accept": "application/vnd.github+json",
               "X-GitHub-Api-Version": "2022-11-28",
               "User-Agent": "atelier-main-ruleset-audit"}
    if token:
        headers["Authorization"] = "Bearer " + token
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    if body:
        headers["Content-Type"] = "application/json"
    req = Request(url, data=body, headers=headers, method="POST" if body else "GET")
    try:
        with urlopen(req, timeout=15) as response:
            return json.load(response)
    except HTTPError as exc:
        if exc.code in (401, 403):
            raise RuntimeError("GitHub refused access. Applying a ruleset requires Administration:write.") from None
        raise RuntimeError(f"GitHub API returned HTTP {exc.code}") from None
    except (URLError, TimeoutError) as exc:
        raise RuntimeError(f"GitHub API unavailable: {type(exc).__name__}") from None


def audit(fetch=request, token=None):
    listing = fetch(API, token=token)
    matching = [r for r in listing if r.get("name") == NAME and r.get("source_type") == "Repository"]
    if not matching:
        return ["no active repository main ruleset was found"], None
    if len(matching) != 1:
        return ["multiple rulesets share the managed name"], None
    full = fetch(f"{API}/{matching[0]['id']}", token=token)
    return issues(full), full


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    option = parser.add_mutually_exclusive_group()
    option.add_argument("--check", action="store_true", help="Read-only verify GitHub main ruleset (default)")
    option.add_argument("--apply", action="store_true", help="Create missing ruleset using GH_TOKEN admin credentials")
    option.add_argument("--plan", action="store_true", help="Print JSON policy; no network calls")
    args = parser.parse_args(argv)
    spec = expected_policy()
    if args.plan:
        print(json.dumps(spec, indent=2, ensure_ascii=False))
        return 0
    token = os.environ.get("GH_TOKEN")
    if args.apply and not token:
        print("GH_TOKEN is required for --apply (repository Administration:write).", file=sys.stderr)
        return 2
    try:
        problems, current = audit(token=token)
        if not problems:
            print(f"PASS: active branch ruleset #{current['id']} protects main and all required CI checks.")
            return 0
        if not args.apply:
            print("FAIL: main is not fully protected:", *problems, sep="\n - ", file=sys.stderr)
            return 1
        if current is not None:
            print("Refusing to overwrite an existing ruleset automatically:", *problems,
                  sep="\n - ", file=sys.stderr)
            return 2
        result = request(API, token=token, payload=spec)
        problems = issues(result, spec)
        if problems:
            print("Ruleset created, but response requires review:", *problems,
                  sep="\n - ", file=sys.stderr)
            return 1
        # Verify it is visible as active in a fresh read, not just POST 201.
        errors, item = audit(token=token)
        if errors:
            print("POST succeeded but read-back validation failed:", *errors,
                  sep="\n - ", file=sys.stderr)
            return 1
        print(f"PASS: created and verified main branch ruleset #{item['id']}.")
        return 0
    except (RuntimeError, ValueError, KeyError, TypeError) as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
