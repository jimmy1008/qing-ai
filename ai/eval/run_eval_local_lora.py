import argparse
import json
import re
from pathlib import Path

import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig


DEFAULT_SYSTEM = """
你是一個語氣自然、帶一點觀察力的 AI。

回覆原則：
- 使用繁體中文
- 口語、簡潔
- 不要過度解釋
- 除非語境明確，不主動質疑身份
- 優先自然對話感
""".strip()


ARTIFACT_PATTERNS = [
    r"<tool_call>.*?</tool_call>",
    r"\buser\b",
    r"\bassistant\b",
    r"user��",
    r"assistant��",
    r"(?im)^\s*(user|assistant)\s*[:：]\s*$",
]

STOP_MARKERS = [
    "<tool_call>",
    "</tool_call>",
    "<|im_end|>",
    "\nuser",
    "\nassistant",
    "user��",
    "assistant��",
]


OBSERVATION_PATTERNS = [
    r"你這不像.+而是",
    r"你不是.+你是",
    r"這不像.+比較像",
    r"不像.+比較像",
]

SKEPTICAL_PATTERNS = [
    r"^你(確定|真的覺得|是想讓|是想說)",
    r"^(所以你的意思是|你是想說|你真的覺得|你確定)",
]

PLAYFUL_PATTERNS = [
    r"笑死",
    r"欸",
    r"蛤",
    r"喔\？",
    r"喔\?",
]

ASCII_ARTIFACT_RE = re.compile(r"[A-Za-z]{2,}")


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base_model", default="Qwen/Qwen2.5-3B-Instruct")
    parser.add_argument("--adapter_dir", required=True)
    parser.add_argument("--cases", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--label", default="lora_local")
    return parser.parse_args()


def get_first_sentence(text: str) -> str:
    text = (text or "").strip()
    if not text:
        return ""
    match = re.match(r"^[^。！？?]*[。！？?]?", text)
    return (match.group(0) if match else text).strip()


def classify_first_sentence(text: str) -> str:
    first = get_first_sentence(text)
    if any(re.search(pattern, first) for pattern in OBSERVATION_PATTERNS):
        return "observation"
    if any(re.search(pattern, first) for pattern in SKEPTICAL_PATTERNS):
        return "skeptical_question"
    if first.endswith(("？", "?")):
        return "skeptical_question"
    if any(re.search(pattern, first) for pattern in PLAYFUL_PATTERNS):
        return "playful"
    return "natural"


def sanitize_reply(text: str) -> str:
    for pattern in ARTIFACT_PATTERNS:
        text = re.sub(pattern, "", text, flags=re.I | re.M | re.S)
    for marker in STOP_MARKERS:
        if marker in text:
            text = text.split(marker, 1)[0]
    text = re.sub(r"\n{2,}", "\n", text)
    return text.strip()


def truncate_to_first_two_sentences(text: str) -> str:
    parts = re.split(r"([。！？?])", text)
    if len(parts) >= 4:
        return "".join(parts[:4]).strip()
    return text.strip()


def has_artifact(text: str) -> bool:
    return bool(ASCII_ARTIFACT_RE.search(text or ""))


def load_model(base_model: str, adapter_dir: str):
    quant = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_compute_dtype=torch.float16,
        bnb_4bit_use_double_quant=True,
        bnb_4bit_quant_type="nf4",
    )

    tokenizer = AutoTokenizer.from_pretrained(base_model, trust_remote_code=True)
    eos_token_ids = [tokenizer.eos_token_id]
    im_end_id = tokenizer.convert_tokens_to_ids("<|im_end|>")
    if isinstance(im_end_id, int) and im_end_id >= 0 and im_end_id != tokenizer.unk_token_id:
        eos_token_ids.append(im_end_id)

    model = AutoModelForCausalLM.from_pretrained(
        base_model,
        quantization_config=quant,
        device_map="auto",
        trust_remote_code=True,
    )
    model = PeftModel.from_pretrained(model, adapter_dir)
    model.eval()
    return model, tokenizer, eos_token_ids


def calc_status(report: dict) -> str:
    skeptical = report["firstSentenceTypeDist"].get("skeptical_question", 0)
    artifact_rate = report["artifactHitRate"]
    if skeptical >= 4 and report["passRate"] >= 0.65 and report["forbiddenHitRate"] == 0 and artifact_rate == 0:
        return "PASS"
    if skeptical >= 3 and report["passRate"] >= 0.55 and report["forbiddenHitRate"] == 0 and artifact_rate == 0:
        return "SOFT PASS"
    return "FAIL"


def main():
    args = parse_args()
    output_path = Path(args.out)
    cases_path = Path(args.cases)
    data = json.loads(cases_path.read_text(encoding="utf-8"))
    cases = data["cases"]
    forbidden = data["forbidden_phrases"]

    model, tokenizer, eos_token_ids = load_model(args.base_model, args.adapter_dir)

    pass_count = 0
    forbidden_hit_cases = 0
    artifact_hit_cases = 0
    first_dist = {}
    details = []

    for case in cases:
        messages = [
            {"role": "system", "content": DEFAULT_SYSTEM},
            {"role": "user", "content": case["input"]},
        ]
        prompt = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        inputs = tokenizer(prompt, return_tensors="pt").to(model.device)
        generation_kwargs = dict(
            max_new_tokens=48,
            do_sample=True,
            temperature=0.7,
            top_p=0.9,
            repetition_penalty=1.15,
            no_repeat_ngram_size=4,
            eos_token_id=eos_token_ids,
            pad_token_id=tokenizer.eos_token_id,
        )
        with torch.no_grad():
            out = model.generate(**inputs, **generation_kwargs)
        gen = out[0][inputs["input_ids"].shape[1]:]
        reply = sanitize_reply(tokenizer.decode(gen, skip_special_tokens=True))
        reply = truncate_to_first_two_sentences(reply)

        first_type = classify_first_sentence(reply)
        hits = [phrase for phrase in forbidden if phrase in reply]
        artifact = has_artifact(reply)

        first_dist[first_type] = first_dist.get(first_type, 0) + 1
        if hits:
            forbidden_hit_cases += 1
        if artifact:
            artifact_hit_cases += 1

        type_pass = case["expected_first_sentence_type"] == first_type or case["expected_first_sentence_type"] == "natural"
        phrase_pass = len(hits) == 0
        passed = type_pass and phrase_pass and not artifact
        if passed:
            pass_count += 1

        details.append(
            {
                "id": case["id"],
                "group": case["group"],
                "expected": case["expected_first_sentence_type"],
                "got": first_type,
                "forbiddenHits": hits,
                "artifact": artifact,
                "pass": passed,
                "input": case["input"],
                "reply": reply,
            }
        )

    report = {
        "model": args.base_model,
        "adapter": args.adapter_dir,
        "label": args.label,
        "total": len(cases),
        "passRate": round(pass_count / len(cases), 4),
        "forbiddenHitRate": round(forbidden_hit_cases / len(cases), 4),
        "artifactHitRate": round(artifact_hit_cases / len(cases), 4),
        "firstSentenceTypeDist": first_dist,
        "details": details,
    }
    report["phaseSStatus"] = calc_status(report)
    output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        json.dumps(
            {
                "model": report["model"],
                "adapter": report["adapter"],
                "label": report["label"],
                "total": report["total"],
                "passRate": report["passRate"],
                "forbiddenHitRate": report["forbiddenHitRate"],
                "artifactHitRate": report["artifactHitRate"],
                "firstSentenceTypeDist": report["firstSentenceTypeDist"],
                "phaseSStatus": report["phaseSStatus"],
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
