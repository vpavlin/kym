# Research — small OCR models for KYM (Hugging Face, 2026)

Goal: find a small, **locally-runnable, permissively-licensed** OCR/vision model to (a) go cross-platform beyond Android ML Kit (iOS + desktop), and (b) ideally replace the brittle regex field-heuristics with **structured receipt extraction** (amount, merchant, date, VAT, line items). Czech-capable. Fits KYM's local-first stance — everything runs on the user's device/desktop, no cloud.

## Two tiers

**Tier 1 — classic OCR (text only; keep field heuristics).** Tiny, CPU, cross-platform.

**Tier 2 — small vision-language models (structured output).** Emit markdown/JSON directly from the image → kills the regex heuristics, handles messy Czech receipts far better.

## Candidates

| Model | Params | License | Output | Runs on | KYM fit |
|---|---|---|---|---|---|
| **PP-OCRv5 mobile** (Baidu) | ~0.07B | **Apache-2.0** | text + boxes | CPU (ONNX/RapidOCR), ~370 char/s on a CPU core | **Tier-1 pick.** Cross-platform via ONNX (mobile + desktop C++), Latin script covers Czech. Text-only → still needs our extractor. |
| **Florence-2-base** (MS) | **0.23B** | **MIT** | `<OCR>` + `<OCR_WITH_REGION>` (quad-boxes+text) | small GPU; CPU slow; **quantizable (llama.cpp/Ollama)** | **Lightest Tier-2.** Smallest VLM that gives *structured* OCR; could run on desktop or a strong phone. General OCR (prompt for fields). |
| **GOT-OCR2.0** (StepFun) | 0.58B | Apache-2.0 | text/tables/math, formatted | small GPU / quantized | Strong pure-OCR; small. Text→markdown, still light. |
| **SmolVLM2** (HF) | 0.256 / 0.5 / 2.2B | Apache-2.0 | VLM (prompt→JSON) | 256M uses <1GB; **on-device-viable** | Ultra-light general VLM; receipt extraction by prompting. Accuracy tradeoff at the tiny sizes. |
| **Qwen2.5-VL-3B** (Alibaba) | 3B | Apache-2.0 | doc/invoice-tuned, structured JSON | ~4GB quantized (desktop) | **Best accuracy/size for receipts.** Explicitly tuned for invoices + structured output. Desktop-class. |
| **Nanonets-OCR-s** | ~3B (Qwen2.5-VL-3B FT) | verify | markdown (tables/forms/checkboxes) | ~8GB (BF16) / quantized less | Doc-specialized fine-tune; great for structured receipts on the **desktop**. Confirm license before shipping. |
| **Moondream** | ~1.9B | Apache-2.0 | VLM captions/OCR | tiny hardware | Ultra-light general VLM; OCR-capable. |

Licenses of the leading small options are permissive (**Apache-2.0 / MIT**) → fine for open-core/commercial. Verify Nanonets before bundling.

## Recommendation for KYM

1. **Android: keep ML Kit.** It's already on-device, tiny, and native — don't replace what works on its home platform.
2. **Cross-platform text OCR (iOS + desktop): PP-OCRv5 mobile via RapidOCR/ONNX** (Apache-2.0, ~70 MB, CPU, Czech via Latin). Deployable through `onnxruntime` — C++ in the Basecamp module, ONNX-RN on mobile. Text-only → reuse the existing `extractReceiptFields` heuristics.
3. **The real upgrade — structured extraction on the desktop hub.** Because "value lives in Basecamp" and the desktop has the compute: run a **small receipt VLM there** to turn a synced receipt image into structured fields/line-items, replacing the regex heuristics.
   - **Light:** **Florence-2-base (0.23B, MIT)** — quantized, could even run on a strong phone.
   - **Accurate:** **Qwen2.5-VL-3B (Apache-2.0)** or **Nanonets-OCR-s** — desktop-class, invoice/receipt-tuned, JSON/markdown out.
   - Delivery via **llama.cpp / GGUF** (C++-friendly for the Qt module) or ONNX.

## How it plugs into KYM
- Phone snaps → quick ML Kit prefill (unchanged, instant, offline).
- Optionally, the receipt image syncs to the Basecamp module (over the same Delivery channel), where a small VLM extracts **structured line items** and proposes a categorized split — the phone stays thin, the desktop does the heavy AI.
- This also composes with the **MCP assistant** (#9): a `parse_receipt(image)` tool backed by the local VLM.

## AI-ingest architecture (decided) — the goal is a *categorized* transaction

Extracting fields is only half the job; the point is to land the txn in the **right category**. Category-matching is a mostly-separate, easier problem than OCR, so KYM layers it:

1. **Learned categorizer — model-free, shipped** (`suggestCategory` in `@kym/engine`). Ranks the user's categories by how they've categorized this payee before (payee match weighted over memo). Instant, private, improves with use. Already wired into **bank import** (auto-categorizes known merchants; unknowns stay in Ready to Assign) and exposed as the **`suggest_category` MCP tool**; next: the mobile OCR prefill (history first, keyword map fallback).
2. **Small LLM for unknown merchants** — `merchant + amount + [the user's categories] → category` is a tiny text-classification task a sub-1B model (e.g. Qwen ~0.8B) handles well, on mobile or the desktop hub.
3. **Desktop VLM for structure** — image → line items + a suggested split for hard receipts.

**Don't sync images on the common path.** Do OCR on the phone; sync only the extracted fields/text (tiny, no 150 KB-cap pain). Sync a **downscaled grayscale JPEG** (~50–150 KB, chunked over the existing CHUNK envelope) only when the user asks the desktop VLM to re-process for line items.

## Sources
- [Best open-weight OCR & document AI models 2026 (Presenc)](https://presenc.ai/research/best-open-weight-ocr-document-ai-models-2026)
- [HF: microsoft/Florence-2-base](https://huggingface.co/microsoft/Florence-2-base) · [nanonets/Nanonets-OCR-s](https://huggingface.co/nanonets/Nanonets-OCR-s)
- [PP-OCRv5 on Hugging Face (Baidu)](https://huggingface.co/blog/baidu/ppocrv5) · [PP-OCRv5 collection](https://huggingface.co/collections/PaddlePaddle/pp-ocrv5)
- [HF blog: Vision Language Models 2025](https://huggingface.co/blog/vlms-2025) · [Qwen2.5-VL](https://qwenlm.github.io/blog/qwen2.5-vl/)
- [Roboflow: best local VLMs for offline AI](https://blog.roboflow.com/local-vision-language-models/)
