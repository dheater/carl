# Help (Error) Messages

Instead of traditional error messages, provide messages that report not only what went wrong, but also, help the user solve the problem.

Format: [WHAT] failed + [WHY] matters + [HOW] to fix + [CONTEXT] codes/values/paths

Fail fast. Recovery only if: specific, recurring, bounded, testable, caller can opt out.

Bad → Good:

- "error: Invalid" → "Cannot use []Type as comptime value. Use: const x: []const T = &[_]T{a, b}"
- "Connection failed" → "SSH_AUTH_FAILED: Public key rejected by 10.0.1.50. Check ~/.ssh/id_rsa perms (0600)"
- "Parse error" → "JSON parse error line 42 col 15: Expected '}' found ','. Missing brace at line 38."
