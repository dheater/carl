# Ephemeral Scripts

**Enforcement:** Guideline for AI (not enforced on projects)

## Principle

⚠️ **BEFORE 2ND SIMILAR EDIT: STOP. Write a script instead.**

**Self-check before every edit:**
1. Am I about to repeat this change elsewhere? → Script
2. Could I describe this as a regex/algorithm? → Script
3. Would a script be faster than 3+ tool calls? → Script

**If YES to any → STOP editing, write script**

---

## Why

- **Efficiency:** Scripts are faster than manual edits
- **Correctness:** Less error-prone than repetitive manual changes
- **Verifiable:** Can test script before applying
- **Reversible:** Can undo script changes easily
- **Auditable:** Script shows exactly what changed

---

## Script Location

**ALWAYS put ephemeral scripts in `.agent/scripts/`**

- ✅ `.agent/scripts/refactor-all-files.sh`
- ✅ `.agent/scripts/update-imports.py`
- ❌ `scripts/` (project scripts only)
- ❌ `/tmp/` (use .agent/scripts/ instead)

**Why:** `.agent/` is gitignored, keeping repository clean.

---

## When to Use

### Required For

- ✅ Mechanical refactors (rename, add/remove fields, update signatures)
- ✅ Batch operations (update all call sites, fix patterns)
- ✅ Any task requiring 3+ similar tool calls

### Forbidden For

- ❌ Exploratory work (figuring out what to do)
- ❌ Single operation (one file, one edit)
- ❌ User needs to see reasoning step-by-step

---

## Examples

### ❌ DON'T: Manual Repetition

```
<invoke str-replace-editor> // file1.py
<invoke str-replace-editor> // file2.py
<invoke str-replace-editor> // file3.py  ← STOP! Write script!
```

### ✅ DO: Script

**Simple (Bash):**
```bash
#!/usr/bin/env bash
set -euo pipefail

find src -name "*.py" -exec sed -i '' 's/oldFunc/newFunc/g' {} \;
python -m pytest tests/ || { echo '{"status": "error"}'; exit 1; }
echo '{"status": "success"}'
```

**Complex (Python):**
```python
#!/usr/bin/env python3
import re, sys, subprocess
from pathlib import Path

for file in Path('src').rglob('*.py'):
    content = file.read_text()
    updated = re.sub(r'pattern', r'replacement', content)
    file.write_text(updated)

result = subprocess.run(['pytest'], capture_output=True)
status = 'success' if result.returncode == 0 else 'error'
print(f'{{"status": "{status}"}}')
sys.exit(result.returncode)
```

---

## Language Choice

**Bash for:**
- File operations (find, grep, sed)
- Simple transforms
- Calling existing tools

**Python for:**
- Complex parsing (AST, regex)
- Multi-step logic
- Error handling
- Cross-platform compatibility

**Not Bash for:**
- Complex logic (use Python)
- Portability (Bash varies across systems)

---

## Output Format

**Always output JSON:**
```json
{"status": "success|error", "summary": "..."}
```

**Exit codes:**
- 0 = success
- 1 = error

**Why:** Parseable by AI and CI tools.

---

## Enforcement

**Caught making 3rd similar edit?**
1. STOP immediately
2. Undo manual edits
3. Write script for ALL edits
4. Run script + verify

**No exceptions.**

---

## Script Template

```bash
#!/usr/bin/env bash
# Description: What this script does
# Usage: ./script-name.sh

set -euo pipefail  # Exit on error, undefined vars, pipe failures

# Your logic here

# Output JSON
echo '{"status": "success", "summary": "Processed N files"}'
```

```python
#!/usr/bin/env python3
"""Description: What this script does"""

import sys
import json

def main():
    # Your logic here
    
    # Output JSON
    print(json.dumps({"status": "success", "summary": "Processed N files"}))
    return 0

if __name__ == "__main__":
    sys.exit(main())
```

---

## References

- Script location (see file-organization.md)
- Subtract first (see subtract-first.md)

