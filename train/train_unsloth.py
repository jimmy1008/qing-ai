"""
QLoRA training scaffold for SocialAI Persona LoRA (Phase 7).
Run in WSL2/Linux with CUDA-enabled PyTorch.
"""

import argparse
import os
from datasets import load_dataset


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--base_model",
        default=os.environ.get("BASE_MODEL", "Qwen/Qwen2.5-3B-Instruct"),
    )
    parser.add_argument("--train_file", default="./socialai_persona_v1_train.jsonl")
    parser.add_argument("--eval_file", default="./socialai_persona_v1_eval.jsonl")
    parser.add_argument("--output_dir", default="./socialai_persona_3b_lora")
    parser.add_argument("--max_seq_length", type=int, default=1024)
    parser.add_argument("--per_device_train_batch_size", type=int, default=1)
    parser.add_argument("--gradient_accumulation_steps", type=int, default=4)
    parser.add_argument("--num_train_epochs", type=float, default=3.0)
    parser.add_argument("--learning_rate", type=float, default=2e-4)
    parser.add_argument("--r", type=int, default=16)
    parser.add_argument("--lora_alpha", type=int, default=32)
    parser.add_argument("--lora_dropout", type=float, default=0.05)
    return parser.parse_args()


def format_chat(example):
    text = ""
    for msg in example["messages"]:
        text += f"<|{msg['role']}|>\n{msg['content']}\n"
    return {"text": text}


def main():
    args = parse_args()
    print("=== TRAIN CONFIG ===")
    print(vars(args))

    import unsloth
    from unsloth import FastLanguageModel
    from trl import SFTConfig, SFTTrainer

    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=args.base_model,
        max_seq_length=args.max_seq_length,
        dtype=None,
        load_in_4bit=True,
    )

    model = FastLanguageModel.get_peft_model(
        model,
        r=args.r,
        lora_alpha=args.lora_alpha,
        lora_dropout=args.lora_dropout,
        target_modules=[
            "q_proj",
            "k_proj",
            "v_proj",
            "o_proj",
            "gate_proj",
            "up_proj",
            "down_proj",
        ],
        bias="none",
        use_gradient_checkpointing=True,
        random_state=3407,
    )

    train_dataset = load_dataset("json", data_files=args.train_file, split="train").map(format_chat)
    eval_dataset = load_dataset("json", data_files=args.eval_file, split="train").map(format_chat)

    training_args = SFTConfig(
        output_dir=args.output_dir,
        per_device_train_batch_size=args.per_device_train_batch_size,
        gradient_accumulation_steps=args.gradient_accumulation_steps,
        num_train_epochs=args.num_train_epochs,
        learning_rate=args.learning_rate,
        fp16=False,
        bf16=True,
        optim="adamw_8bit",
        logging_steps=1,
        do_eval=True,
        eval_strategy="steps",
        eval_steps=5,
        save_steps=20,
        save_total_limit=2,
        report_to="none",
        max_length=args.max_seq_length,
        dataset_num_proc=1,
        activation_offloading=False,
    )

    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=train_dataset,
        eval_dataset=eval_dataset,
        dataset_text_field="text",
        max_seq_length=args.max_seq_length,
        packing=False,
        args=training_args,
    )

    result = trainer.train()
    print("=== TRAIN COMPLETE ===")
    print(result)
    trainer.save_model(args.output_dir)
    tokenizer.save_pretrained(args.output_dir)
    print(f"Saved LoRA adapter to: {args.output_dir}")


if __name__ == "__main__":
    main()
