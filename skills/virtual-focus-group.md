# Virtual Focus Group

**Purpose:** Simulate expert opinions to validate ideas early, before investing months of work.

**Enforcement:** Skill for AI (technique)

**Validated:** Empirical (Zai project - rejected ideas in 2 weeks instead of months).

## When to Use

**Use virtual focus groups to:**
- Validate new project ideas before building
- Get expert perspectives on design decisions
- Identify problems early
- Challenge assumptions with diverse viewpoints
- Reject bad ideas in hours, not months

**Don't use for:**
- Replacing real user research (this is for early validation)
- Final decisions (use data and real feedback)
- Avoiding building prototypes (still need to prove with data)

## How It Works

### 1. Select Personas

**Choose 4-6 real experts relevant to your domain:**

**For programming languages:**
- Casey Muratori (performance, simplicity)
- Andrew Kelley (Zig creator, pragmatism)
- Richard Feldman (functional programming, Elm)
- Ginger Bill (Odin creator, systems programming)
- Ryan Fleury (UI frameworks, tooling)

**For systems programming:**
- Linus Torvalds (Linux kernel, C)
- Jonathan Blow (game development, JAI)
- John Carmack (performance, architecture)
- Eskil Steenberg (finish software, stability)

**For web development:**
- DHH (Rails, convention over configuration)
- Rich Harris (Svelte, compiler-driven)
- Ryan Dahl (Node.js, Deno)
- Evan You (Vue, progressive enhancement)

**For databases:**
- Joe Hellerstein (database theory)
- Andy Pavlo (database systems)
- Phil Eaton (DuckDB, embedded databases)
- Martin Kleppmann (distributed systems)

**Always include:**
- An AI agent perspective (Claude, GPT-4, etc.) - represents AI tooling view
- Domain experts with DIFFERENT philosophies (not echo chamber)

### 2. Format the Request

**Template:**

```
I would like you to conduct a virtual focus group.

You are the moderator and you will need to simulate the participants:
- [Persona 1]
- [Persona 2]
- [Persona 3]
- [Persona 4]
- [Persona 5]
- [AI Agent] (to represent an AI agent's view)

Simulate them using their personas and opinions as best you can. Don't water down their personas.

I would like to get their opinions on [PROJECT/IDEA].

Format:
- What they like (3 things)
- What they don't like (3-5 things)
- What they would change and how (3-5 things)

Participants take turns sharing an item from their list.
This prompts a discussion among the participants about that topic.
Participants cross things off their list and the discussion flows.
Repeat with participants sharing until their notes are exhausted.

As moderator: Let the conversation flow. Only intervene when the conversation gets stuck.
Make sure everyone gets their opinions heard.
```

### 3. Run the Focus Group

**AI will:**
1. Simulate each persona authentically (don't water down opinions)
2. Let participants debate and challenge each other
3. Cross items off lists as they're discussed
4. Moderate only when stuck
5. Ensure all voices are heard

**You get:**
- Diverse expert perspectives
- Identification of problems you didn't see
- Validation or rejection of core assumptions
- Specific suggestions for improvement

### 4. Extract Insights

**After the focus group, ask:**

**What would make you kill this idea?**
- If most experts would reject → kill early
- If mixed opinions → need data to decide
- If most support → proceed with caution

**What are the biggest risks?**
- Technical risks (performance, complexity)
- Adoption risks (learning curve, migration)
- Maintenance risks (sustainability, tooling)

**What would you change?**
- Specific, actionable suggestions
- Prioritize by consensus (what multiple experts agree on)

## Example: Zai Project

**Request:** Virtual focus group on Zai programming language

**Personas:** Casey Muratori, Andrew Kelley, Richard Feldman, Ginger Bill, Ryan Fleury, Claude Opus

**Result:**
- Most experts questioned value vs Zig
- Identified immutable-by-default as contentious
- Suggested proving with data (not intuition)
- Led to 3 experiments measuring token counts, `mut` usage
- Data showed Zig was equal or better → killed Zai in 2 weeks

**Value:** Rejected idea in 2 weeks instead of months

**Source:** `~/src/focus-group.md`, `~/src/zai/`

## Best Practices

### Do:
- **Choose diverse personas** - Different philosophies, not echo chamber
- **Don't water down opinions** - Let experts be opinionated
- **Let them debate** - Disagreement reveals assumptions
- **Extract actionable insights** - What would you change? How?
- **Follow up with data** - Virtual focus group → experiments → decision

### Don't:
- **Replace real user research** - This is for early validation only
- **Ignore consensus** - If all experts reject, listen
- **Cherry-pick opinions** - Consider all feedback, even negative
- **Skip building prototypes** - Still need to prove with data

## Integration with Project Assessment

**Week 1 decision point:**
1. Run virtual focus group
2. Extract insights (what would kill this idea?)
3. If most experts reject → kill or rescope
4. If mixed → design experiments to get data
5. If most support → build prototype

**See:** `rules/project-assessment.md` for full framework

## Related

- `rules/project-assessment.md` - When to use virtual focus groups
- `~/src/focus-group.md` - Original Zai example
- `~/src/zai/research/IMMUTABLE-BY-DEFAULT-ANALYSIS.md` - Data that followed focus group

