# Generator Audit Notes

## Scope
- File: `train/generate_persona_dataset.py`
- Audit target: hidden scaffold, debug labels, English seed leakage, meta tags

## Findings
- No visible debug labels are written into assistant content.
- No hidden scaffold strings such as `<=...$>` are emitted by the current generator.
- System prompts and assistant targets are Chinese-only at the content level.
- JSON keys and role names remain English by format requirement, but message content is sanitized before write.
- The generator now rejects any sample whose content matches `[A-Za-z<>$=_]`.

## Risk Assessment
- Current visible dataset content does not explain v3 artifacts by itself.
- Remaining contamination is more likely adapter-side or generation-side residual behavior, not raw JSONL payload.

## Guardrails Added For v4
- `is_clean_chinese()` hard gate before JSONL write.
- Rejected samples are dropped, not silently kept.
- `dataset_audit.json` is emitted on each generation run.
- `train_dataset_scan_report.json` exists for regex-level forensic scan.
