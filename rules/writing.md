# Writing

**Enforcement:** Guideline for AI (applies to all project-facing text)

## Principle

Write for a human who will actually read it. If it sounds like a template was filled in, rewrite it.

Short over long. Specific over general. Active over passive.

---

## Tickets

Lead with the change, not the process.

**Include:**
- What needs to happen (1–2 sentences of real content)
- Acceptance criteria as specific, testable facts
- `blocked-by:` if relevant

**AC must be testable.** If you can't write a test for it before writing the code, it's not AC — it's aspiration. Rewrite it until it's specific enough to fail a test.

**Don't include:**
- "This ticket involves..." / "This task is responsible for..."
- Criteria that apply to everything ("code should be tested", "follow coding standards")
- Restatements of the PRD

**Good:**
```
POST /auth/login — validate credentials, return JWT. 400 on bad input, 401 on wrong password.

AC:
- Happy path returns 200 + token
- Wrong password returns 401, no token
- Missing fields return 400 with which fields
```

**Bad:**
```
This ticket involves implementing the authentication endpoint which will be responsible
for validating user credentials and returning the appropriate authentication tokens
upon successful login.

Acceptance Criteria:
- The endpoint should accept a username and password
- The endpoint should validate the credentials
- The endpoint should return an appropriate response
```

---

## Commit messages

Subject: imperative mood, ≤72 chars, no period.

```
Fix login redirect after password reset   ✅
Fixed the login redirect issue            ❌
This commit fixes the login redirect      ❌
```

Body: only when the why isn't obvious from the diff. Skip it otherwise. Never start with "This commit...".

---

## Documentation

One sentence beats one paragraph. If the code needs a paragraph to explain, improve the code first.

Write what a reader needs to not be confused, then stop. No summaries of what the reader just read.

---

## The test

Read it back. If it sounds like it came from a template or a corporate memo, cut it down.
