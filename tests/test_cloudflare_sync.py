"""Offline regression tests for direct stdin-only Cloudflare credential sync."""
import importlib.util
import json
from pathlib import Path
import subprocess

import pytest


def module():
    path=Path(__file__).resolve().parents[1]/"scripts"/"sync-cloudflare-secrets.py"
    spec=importlib.util.spec_from_file_location("secret_sync_for_test",path)
    m=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def test_sync_only_allowlisted_keys_over_stdin(tmp_path, monkeypatch, capsys):
    m=module()
    monkeypatch.setattr(m,"ROOT",tmp_path)
    monkeypatch.setattr(m,"ENV_FILE",tmp_path/".env")
    (tmp_path/"cloudflare").mkdir()
    token="123456789:"+"A"*40
    (tmp_path/".env").write_text(
        "BOT_TOKEN="+token+"\nADMIN_IDS=123456789\nDATABASE_PATH=data/private.sqlite3\n",
        encoding="utf-8",
    )
    calls=[]
    def run(cmd,**kwargs):
        calls.append(cmd)
        assert token not in " ".join(cmd)
        assert kwargs["capture_output"] is True
        if cmd[4]=="bulk":
            secrets=json.loads(kwargs["input"])
            assert set(secrets)=={"BOT_TOKEN","ADMIN_IDS","WEBHOOK_SECRET"}
            assert secrets["BOT_TOKEN"]==token
            assert "DATABASE_PATH" not in secrets
            assert len(secrets["WEBHOOK_SECRET"])>=32
            return subprocess.CompletedProcess(cmd,0,"upserted 3 secrets","")
        if cmd[4]=="list":
            return subprocess.CompletedProcess(cmd,0,json.dumps([
              {"name":name,"type":"secret_text"} for name in m.REQUIRED
            ]),"")
        pytest.fail("Unexpected external command")
    monkeypatch.setattr(m.subprocess,"run",run)
    m.sync()
    assert len(calls)==2
    assert token not in capsys.readouterr().out
    assert "WEBHOOK_SECRET=" in (tmp_path/".env").read_text()
    assert sorted(p.name for p in tmp_path.iterdir())==[".env","cloudflare"]


def test_invalid_config_never_contacts_cloudflare(tmp_path,monkeypatch):
    m=module()
    monkeypatch.setattr(m,"ROOT",tmp_path)
    monkeypatch.setattr(m,"ENV_FILE",tmp_path/".env")
    (tmp_path/".env").write_text("BOT_TOKEN=invalid\nADMIN_IDS=123\n")
    monkeypatch.setattr(m.subprocess,"run",lambda *a,**kw: pytest.fail("Should never call Wrangler"))
    with pytest.raises(RuntimeError,match="BOT_TOKEN"):
        m.sync()


def test_bulk_failure_does_not_print_token(tmp_path,monkeypatch,capsys):
    m=module()
    monkeypatch.setattr(m,"ROOT",tmp_path)
    monkeypatch.setattr(m,"ENV_FILE",tmp_path/".env")
    (tmp_path/"cloudflare").mkdir()
    token="123456789:"+"B"*40
    (tmp_path/".env").write_text("BOT_TOKEN="+token+"\nADMIN_IDS=123\nWEBHOOK_SECRET="+"Z"*42+"\n")
    monkeypatch.setattr(m.subprocess,"run",lambda cmd,**kw:subprocess.CompletedProcess(cmd,2,"","error"))
    with pytest.raises(RuntimeError,match="Wrangler failed"):
        m.sync()
    assert token not in capsys.readouterr().out
