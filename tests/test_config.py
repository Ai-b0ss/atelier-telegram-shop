"""Local config: safe .env handling without exposing tokens to Git or logs."""
from atelier.config import load_local_env


def test_local_env_reads_known_settings_without_overwriting_environment(tmp_path, monkeypatch):
    cfg = tmp_path / ".env"
    cfg.write_text(
        "# private settings\n"
        "BOT_TOKEN=123456:THIS_IS_A_TEST_VALUE_NOT_A_REAL_TOKEN\n"
        "ADMIN_IDS='777,888'\n"
        "DATABASE_PATH=data/atelier.sqlite3\n"
        "PYTHONPATH=some-unexpected-path\n"
        "BROKEN_LINE\n",
        encoding="utf-8",
    )
    for key in ("BOT_TOKEN", "ADMIN_IDS", "DATABASE_PATH", "PYTHONPATH"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("ADMIN_IDS", "999")
    load_local_env(cfg)
    import os
    assert os.environ["BOT_TOKEN"] == "123456:THIS_IS_A_TEST_VALUE_NOT_A_REAL_TOKEN"
    assert os.environ["ADMIN_IDS"] == "999"
    assert os.environ["DATABASE_PATH"] == "data/atelier.sqlite3"
    assert "PYTHONPATH" not in os.environ


def test_local_env_absence_is_safe(tmp_path, monkeypatch):
    monkeypatch.delenv("BOT_TOKEN", raising=False)
    load_local_env(tmp_path / ".env")
    import os
    assert "BOT_TOKEN" not in os.environ


def test_demo_mode_fails_closed_without_explicit_production_approval(monkeypatch):
    from atelier.config import is_demo_mode
    monkeypatch.delenv("DEMO_MODE", raising=False)
    assert is_demo_mode() is True
    monkeypatch.setenv("DEMO_MODE", "1")
    assert is_demo_mode() is True
    monkeypatch.setenv("DEMO_MODE", "unexpected")
    assert is_demo_mode() is True
    monkeypatch.setenv("DEMO_MODE", "0")
    assert is_demo_mode() is False
