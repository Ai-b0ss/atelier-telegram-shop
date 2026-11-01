"""Offline contract tests for GitHub main branch ruleset governance."""
from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("main_ruleset", ROOT / "scripts" / "main_ruleset.py")
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


def sample_active_rule():
    doc = module.expected_policy()
    doc["id"] = 42
    doc["source_type"] = "Repository"
    return doc


def test_policy_is_free_branch_ruleset_with_no_admin_bypasses():
    doc = module.expected_policy()
    assert doc["target"] == "branch"
    assert doc["enforcement"] == "active"
    assert doc["bypass_actors"] == []
    assert doc["conditions"]["ref_name"]["include"] == ["refs/heads/main"]
    required = module.rule_map(doc)["required_status_checks"]["parameters"]
    assert required["strict_required_status_checks_policy"] is True
    assert len(required["required_status_checks"]) >= 7
    assert "pytest (3.11)" in [c["context"] for c in required["required_status_checks"]]
    assert not module.issues(sample_active_rule())


def test_missing_required_check_or_disabled_ruleset_fails_audit():
    base = sample_active_rule()
    bad = copy.deepcopy(base)
    bad["rules"][-1]["parameters"]["required_status_checks"].pop()
    assert "missing required CI:" in " ".join(module.issues(bad))
    bad = copy.deepcopy(base)
    bad["enforcement"] = "disabled"
    assert any("not enforced" in p for p in module.issues(bad))
    bad = copy.deepcopy(base)
    bad["conditions"]["ref_name"]["include"] = ["refs/heads/develop"]
    assert any("does not target main" in p for p in module.issues(bad))


def test_hidden_bypass_list_and_explicit_bypass_policy():
    no_bypass = sample_active_rule()
    no_bypass.pop("bypass_actors")
    # GitHub public API may omit this field. Do not infer absence or presence.
    assert not module.issues(no_bypass)
    unsafe = sample_active_rule()
    unsafe["bypass_actors"] = [{"actor_type": "RepositoryRole", "actor_id": 5,
                               "bypass_mode": "always"}]
    assert any("bypass actors" in p for p in module.issues(unsafe))


def test_audit_checks_full_rule_detail_not_just_list_name():
    rule = sample_active_rule()
    urls = []

    def fetch(url, token=None):
        urls.append(url)
        if url == module.API:
            return [{"id": 42, "name": module.NAME, "source_type": "Repository",
                     "enforcement": "active"}]
        assert url == module.API + "/42"
        return rule

    problems, found = module.audit(fetch=fetch)
    assert not problems and found == rule
    assert len(urls) == 2

    rule["rules"] = []
    problems, _ = module.audit(fetch=fetch)
    assert any("required_status_checks" in p for p in problems)


def test_audit_missing_ruleset_is_not_ignored():
    problems, item = module.audit(fetch=lambda url, token=None: [])
    assert item is None
    assert problems == ["no active repository main ruleset was found"]


def test_default_does_not_mutate_and_apply_requires_admin_token(monkeypatch):
    monkeypatch.delenv("GH_TOKEN", raising=False)
    assert module.main(["--apply"]) == 2
    # --plan cannot call network
    monkeypatch.setattr(module, "request", lambda *args, **kwargs: (_ for _ in ()).throw(
        AssertionError("network forbidden in --plan")))
    assert module.main(["--plan"]) == 0
