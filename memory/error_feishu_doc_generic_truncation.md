---
type: error
date: 2026-06-28
---

# Feishu/Lark document generic extraction truncation

## What did not work

Using generic browser extraction on Feishu/Lark Wiki or Docx pages can exit successfully while only capturing the outline, first paragraphs, and shell text such as `Unable to print`, `0 words`, `Help Center`, or `Keyboard Shortcuts`.

## What worked

Use `lark-cli docs +fetch --api-version v2 --doc <url> --doc-format markdown --as user --format json` or the `baoyu-url-to-markdown` `lark-doc` adapter for `/wiki/` and `/docx/` URLs.

## Next time

For Feishu/Lark/Doubao document URLs, prefer the document API path first and treat a short generic capture as low-quality even when the command exits 0.
