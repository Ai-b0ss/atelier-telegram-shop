"""Fail closed when repository packaging or BPMN structure becomes inconsistent."""
from __future__ import annotations

import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NS = "{http://www.omg.org/spec/BPMN/20100524/MODEL}"


def verify_bpmn(path: Path) -> None:
    tree = ET.parse(path)
    process = tree.find(f".//{NS}process")
    assert process is not None, f"No BPMN process: {path}"
    nodes = {element.attrib["id"] for element in process
             if element.tag in (f"{NS}startEvent", f"{NS}endEvent",
                                f"{NS}task", f"{NS}exclusiveGateway")}
    flows = [element for element in process if element.tag == f"{NS}sequenceFlow"]
    flow_ids = {flow.attrib["id"] for flow in flows}
    assert len(flow_ids) == len(flows), f"Duplicate sequence flow: {path}"
    for flow in flows:
        assert flow.attrib["sourceRef"] in nodes, f"Missing source: {path}"
        assert flow.attrib["targetRef"] in nodes, f"Missing target: {path}"
    assert sum(e.tag == f"{NS}startEvent" for e in process) == 1
    assert sum(e.tag == f"{NS}endEvent" for e in process) >= 1
    for element in process:
        if element.tag in (f"{NS}task", f"{NS}exclusiveGateway"):
            for child in element:
                if child.tag in (f"{NS}incoming", f"{NS}outgoing"):
                    assert child.text in flow_ids, f"Dangling flow reference: {path}"


def verify_tracked_files() -> None:
    if (ROOT / ".git").is_dir():
        tracked = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, check=True,
                                 capture_output=True).stdout.decode().split("\0")
    else:
        # A source ZIP intentionally has no Git metadata.
        tracked = [str(path.relative_to(ROOT)) for path in ROOT.rglob("*") if path.is_file()]
    assert "README.md" in tracked and "atelier/store.py" in tracked
    for path in tracked:
        if not path:
            continue
        parts = Path(path).parts
        assert not any(part.startswith(".env") and part != ".env.example" for part in parts), path
        assert not any(part in ("data", "reports", "backups", ".venv", "__pycache__") for part in parts), path
        assert not path.endswith((".pyc", ".sqlite3", ".sqlite3-wal", ".sqlite3-shm")), path


def main() -> None:
    for name in ("catalog-sales.bpmn", "custom-tailoring.bpmn"):
        verify_bpmn(ROOT / "docs" / name)
    verify_tracked_files()
    print("Release checks: BPMN structure and tracked source files OK")


if __name__ == "__main__":
    main()
