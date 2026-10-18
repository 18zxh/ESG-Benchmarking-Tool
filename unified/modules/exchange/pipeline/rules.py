"""Read the selected bundled ruleset; model output cannot replace its wording."""
import json
from pathlib import Path
from pipeline.errors import RequestError

ROOT = Path(__file__).resolve().parents[1]


def load_rules(exchange, context=None):
    if exchange not in ("sh", "sz", "bj", "hk"):
        raise RequestError("请选择交易所。")
    try:
        rules = json.loads((ROOT / "data/ruleset" / (exchange + ".json")).read_text("utf-8"))
        expected = 71 if exchange == "hk" else 21
        if len(rules["topics"]) != expected or len({t["id"] for t in rules["topics"]}) != expected:
            raise ValueError
        if exchange == "hk":
            from pipeline.hk_assessment import attach_assessment
            attach_assessment(rules)
        else:
            from pipeline.assessment_reference import attach_mainland_methodology
            attach_mainland_methodology(rules)
        if exchange == "hk" and context is not None:
            from pipeline.hk_rules import apply_hk_rules
            return apply_hk_rules(rules, context)
        return rules
    except (OSError, ValueError, KeyError):
        raise RequestError("规则数据不可用，请核对分发文件。", "ruleset", 500) from None
