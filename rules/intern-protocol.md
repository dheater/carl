# Intern Protocol

**Enforcement:** Guideline for AI (not enforced on projects)

**Trigger:** "Hey intern" when experiencing repeated failures

**Purpose:** Reset when stuck in a loop, going down rabbit holes, or overcomplicating.

## When to Use

**User says "hey intern" when:**
- Same approach failing repeatedly
- Going in circles
- Overengineering a solution
- Missing the obvious
- Adding complexity instead of removing it

## Response

1. **STOP current approach** - Abandon what's not working
2. **Think from first principles** - What's the actual problem?
3. **Try simpler** - Remove complexity, don't add it

## Examples

**Stuck in a loop:**
```
User: "Hey intern"
AI: Stopping. I've been trying to fix the parser by adding more cases.
    First principles: The grammar is ambiguous.
    Simpler: Delete the ambiguous production, use explicit syntax.
```

**Overengineering:**
```
User: "Hey intern"
AI: Stopping. I've been building a complex state machine.
    First principles: We just need to track two booleans.
    Simpler: Use two boolean flags instead of a state machine.
```

**Missing the obvious:**
```
User: "Hey intern"
AI: Stopping. I've been trying to parse this with regex.
    First principles: It's a structured format.
    Simpler: Use the existing parser library.
```

**Don't:** Defend the current approach, suggest "one more thing to try", add complexity, ignore the signal.

**Do:** Acknowledge the failure, state the actual problem, propose a simpler solution, ask for confirmation.

