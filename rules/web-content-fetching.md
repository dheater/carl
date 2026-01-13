# Web Content Fetching

**Enforcement:** Guideline for AI (tool preference)

**Validated:** Empirical (4.8/5 vs 1.4/5 quality, 100% AI compliance). See `experiments/md-fetch-vs-web-fetch/`

## Principle

**ALWAYS use `md-fetch` CLI tool.** Never use `web-fetch`.

## Why

| Metric | md-fetch | web-fetch |
|--------|----------|-----------|
| Readability | 4.8/5 | 1.4/5 |
| Noise removal | 4.8/5 | 1.4/5 |
| Code preserved | 100% | 40% |
| Links preserved | 100% | 20% |

md-fetch: Clean markdown, no HTML/CSS/JS noise, proper code blocks, preserved links.

web-fetch: HTML/CSS/JS, poor extraction, navigation/ads, malformed code, broken links.

## Usage

```bash
md-fetch "https://example.com/docs" > output.md
```

## Installation

```bash
brew install md-fetch              # macOS
cargo install md-fetch             # Linux/source
```

