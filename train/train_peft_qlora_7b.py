import argparse
import json
import os
from pathlib import Path

import torch
from datasets import Dataset
from peft import LoraConfig, prepare_model_for_kbit_training
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BitsAndBytesConfig,
    Trainer,
    TrainingArguments,
)


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base_model", default="Qwen/Qwen2.5-7B-Instruct")
    parser.add_argument("--train_file", required=True)
    parser.add_argument("--eval_file", required=True)
    parser.add_argument("--extra_train_file")
    parser.add_argument("--extra_train_repeat", type=int, default=1)
    parser.add_argument("--output_dir", default="train/socialai_persona_7b_lora_v1")
    parser.add_argument("--max_seq_length", type=int, default=512)
    parser.add_argument("--per_device_train_batch_size", type=int, default=1)
    parser.add_argument("--gradient_accumulation_steps", type=int, default=8)
    parser.add_argument("--num_train_epochs", type=float, default=2.0)
    parser.add_argument("--learning_rate", type=float, default=2e-4)
    parser.add_argument("--lora_r", type=int, default=32)
    parser.add_argument("--lora_alpha", type=int, default=32)
    parser.add_argument("--lora_dropout", type=float, default=0.05)
    parser.add_argument("--fp16", action="store_true", default=True)
    return parser.parse_args()


def read_jsonl(path: str):
    rows = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    return rows


def format_messages(messages):
    text = ""
    for msg in messages:
        text += f"<|{msg['role']}|>\n{msg['content']}\n"
    return text


def build_sft_sample(messages, tokenizer, max_seq_length):
    system_user_msgs = []
    assistant_msg = None

    for message in messages:
        if message["role"] == "assistant":
            assistant_msg = message["content"]
        else:
            system_user_msgs.append(message)

    if assistant_msg is None:
        raise ValueError("Missing assistant message in training sample.")

    system_user_text = tokenizer.apply_chat_template(
        system_user_msgs,
        tokenize=False,
        add_generation_prompt=True,
    )

    system_user_ids = tokenizer(
        system_user_text,
        truncation=True,
        max_length=max_seq_length,
        add_special_tokens=False,
    )["input_ids"]

    assistant_ids = tokenizer(
        assistant_msg,
        truncation=True,
        max_length=max_seq_length,
        add_special_tokens=False,
    )["input_ids"]

    if tokenizer.eos_token_id is not None:
        assistant_ids = assistant_ids + [tokenizer.eos_token_id]

    available_assistant_len = max(max_seq_length - len(system_user_ids), 0)
    assistant_ids = assistant_ids[:available_assistant_len]

    input_ids = system_user_ids + assistant_ids
    labels = ([-100] * len(system_user_ids)) + assistant_ids
    attention_mask = [1] * len(input_ids)

    if len(input_ids) != len(labels):
        raise ValueError("Input/label length mismatch after loss masking.")

    supervised_tokens = sum(1 for token in labels if token != -100)
    if supervised_tokens != len(assistant_ids):
        raise ValueError("Assistant-only loss mask is invalid.")

    return {
        "input_ids": input_ids,
        "labels": labels,
        "attention_mask": attention_mask,
    }


def prepare_dataset(rows, tokenizer, max_seq_length):
    samples = [build_sft_sample(row["messages"], tokenizer, max_seq_length) for row in rows]
    ds = Dataset.from_list(samples)

    return ds


def find_target_modules(model):
    target_keywords = ("q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj")
    names = set()
    for name, module in model.named_modules():
        if any(keyword in name for keyword in target_keywords):
            names.add(name.split(".")[-1])
    return sorted(names)


class DataCollatorForCausalLM:
    def __init__(self, tokenizer):
        self.tokenizer = tokenizer

    def __call__(self, features):
        labels = [feature["labels"] for feature in features]
        inputs = [
            {
                "input_ids": feature["input_ids"],
                "attention_mask": feature["attention_mask"],
            }
            for feature in features
        ]
        batch = self.tokenizer.pad(
            inputs,
            padding=True,
            return_tensors="pt",
        )
        max_len = batch["input_ids"].shape[1]
        padded_labels = []
        for label_ids in labels:
            pad_len = max_len - len(label_ids)
            padded_labels.append(label_ids + ([-100] * pad_len))
        batch["labels"] = torch.tensor(padded_labels, dtype=torch.long)
        return batch


def main():
    args = parse_args()
    print("=== TRAIN CONFIG ===")
    print(vars(args))

    quant = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_use_double_quant=True,
        bnb_4bit_compute_dtype=torch.float16,
    )

    tokenizer = AutoTokenizer.from_pretrained(args.base_model, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    model = AutoModelForCausalLM.from_pretrained(
        args.base_model,
        quantization_config=quant,
        device_map="auto",
        trust_remote_code=True,
    )
    model.config.use_cache = False
    model = prepare_model_for_kbit_training(model)

    target_modules = find_target_modules(model)
    if not target_modules:
        raise RuntimeError("No target modules found for LoRA.")
    print("target_modules:", target_modules)

    peft_config = LoraConfig(
        r=args.lora_r,
        lora_alpha=args.lora_alpha,
        lora_dropout=args.lora_dropout,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=target_modules,
    )

    from peft import get_peft_model

    model = get_peft_model(model, peft_config)
    model.gradient_checkpointing_enable()

    train_rows = read_jsonl(args.train_file)
    if args.extra_train_file:
        extra_rows = read_jsonl(args.extra_train_file)
        train_rows.extend(extra_rows * max(args.extra_train_repeat, 1))
    eval_rows = read_jsonl(args.eval_file)
    train_dataset = prepare_dataset(train_rows, tokenizer, args.max_seq_length)
    eval_dataset = prepare_dataset(eval_rows, tokenizer, args.max_seq_length)
    collator = DataCollatorForCausalLM(tokenizer)

    training_args = TrainingArguments(
        output_dir=args.output_dir,
        per_device_train_batch_size=args.per_device_train_batch_size,
        gradient_accumulation_steps=args.gradient_accumulation_steps,
        num_train_epochs=args.num_train_epochs,
        learning_rate=args.learning_rate,
        warmup_ratio=0.03,
        logging_steps=1,
        save_strategy="epoch",
        eval_strategy="epoch",
        fp16=args.fp16,
        bf16=False,
        gradient_checkpointing=True,
        optim="paged_adamw_8bit",
        group_by_length=True,
        report_to="none",
        remove_unused_columns=False,
    )

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=train_dataset,
        eval_dataset=eval_dataset,
        data_collator=collator,
    )

    result = trainer.train()
    print("=== TRAIN COMPLETE ===")
    print(result)

    os.makedirs(args.output_dir, exist_ok=True)
    model.save_pretrained(args.output_dir)
    tokenizer.save_pretrained(args.output_dir)
    print(f"Saved LoRA adapter to: {args.output_dir}")


if __name__ == "__main__":
    main()
