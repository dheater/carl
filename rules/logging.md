# Logging

**Enforcement:** ✅ Automated (`carl check_logs` detects unstructured logging, skips trace patterns like std.debug.print)

## Principle

Structured, queryable logs for control plane (failures + key operations). Multi-line key=value format. All events have `timestamp` and `event_id`. Failures include `session_id` and full context. Success events are minimal. Data plane uses simple trace strings (compile-time disabled in release).

---

## Why

- **Debugging customer issues** - Queryable logs enable root cause analysis
- **Event correlation** - `event_id` for specific events, `session_id` for session tracing
- **AI-friendly format** - Structured data for automated analysis
- **Performance** - Data plane logging disabled in release builds

---

## Log Categories

| Category | Level | Format | Fields | When |
|----------|-------|--------|--------|------|
| **Control plane failures** | ERROR/WARN | Structured multi-line | Full context | All errors |
| **Control plane success** | INFO | Structured multi-line | Minimal | Key operations only |
| **Data plane** | TRACE | Simple string | N/A | Debug builds only |
| **Protocol messages** | DEBUG | Existing format | N/A | Keep as-is |

---

## Event Format

### Success Event (Minimal)
```
CONNECTION_ESTABLISHED
	timestamp=2026-01-08T15:23:45.123Z
	event_id=evt_abc123
```

### Failure Event (Full Context)
```
SSH_AUTH_FAILED
	timestamp=2026-01-08T15:23:45.123Z
	event_id=evt_def456
	session_id=sess_456
	username=john.doe
	server=10.0.1.50
	error_code=-18
	libssh2_error=Unable to extract public key from private key
```

---

## Event Naming

**Convention:** `SCREAMING_SNAKE_CASE`

**Failures:**
- `CONNECTION_FAILED`
- `SSH_AUTH_FAILED`
- `SSH_HANDSHAKE_FAILED`
- `PORT_FORWARD_FAILED`
- `HTTP_TUNNEL_FAILED`

**Success:**
- `CONNECTION_ESTABLISHED`
- `SESSION_CREATED`
- `TUNNEL_OPENED`
- `REQUEST_COMPLETED`

---

## Standard Fields

**All events:** `timestamp` (ISO8601), `event_id` (unique)

**Failures add:** `session_id`, `error_code`, `error_message`, identity (user_id, username), network (server, ports), context (auth_method, libssh2_error)

**Success:** No additional fields

---

## Implementation

```cpp
// Generate IDs
auto event_id = log_events::generateEventId();
auto timestamp = log_events::getTimestamp();

// Failure
LOG_ERROR("%s\n\ttimestamp=%s\n\tevent_id=%s\n\tsession_id=%s\n\tusername=%s\n\tserver=%s\n\terror_code=%d",
          AUTH_FAILED, timestamp.c_str(), event_id.c_str(), ...);

// Success
LOG_INFO("%s\n\ttimestamp=%s\n\tevent_id=%s", CONNECTION_ESTABLISHED, ...);

// Data plane (debug only)
LOG_TRACE("Forwarding %zu bytes", len);
```

---

## Querying

```bash
# Find failures
grep "SSH_AUTH_FAILED" logs.txt
grep "username=john.doe" logs.txt
grep "error_code=" logs.txt

# Trace session
SESSION=$(grep "PORT_FORWARD_FAILED" logs.txt | grep -o "session_id=[^ ]*" | head -1)
grep "$SESSION" logs.txt

# Extract metrics
awk '/^[A-Z_]+$/ {print}' logs.txt | sort | uniq -c
```

---

## Correlation

**Success:** No `session_id`, just `timestamp` + `event_id` (lightweight)

**Failure:** Include `session_id` + full context

**Query:** Find failure → extract `session_id` → grep for related events by timestamp

---

## Checklist

- [ ] Event name `SCREAMING_SNAKE_CASE`?
- [ ] All events have `timestamp`, `event_id`?
- [ ] Failures have `session_id`, `error_code`, context?
- [ ] Success minimal (no `session_id`, `duration_ms`)?
- [ ] Data plane uses `TRACE` (debug only)?

---

## Enforcement

**Automated:** `carl lint-logs`, check for unstructured errors

**Code review:** Structured format? Success minimal? Data plane uses trace?

---

## References

- `carl/rules/helpful-errors.md`

