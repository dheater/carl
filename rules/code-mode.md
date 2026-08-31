# Code Mode

`run_code` is the only tool you call directly, and each program costs one model round-trip. A program that makes a single tool call spends that round-trip and buys nothing.

- **Batch per question, not per call.** Before writing a program, list every read, grep, and glob whose arguments you already know, and issue them together — `Promise.all` for the independent ones. Two programs in a row where the second's arguments did not depend on the first's output was one program.
- **Return conclusions, not transcripts.** Print the matched lines, the failing test name, the field you parsed. Never print a whole file, a whole build log, or a whole directory listing. If a program returns more bytes than its tool calls fetched, it did no work.
- **Keep intermediates in variables.** A file you read is in scope for the rest of the program; re-reading it in a later program pays for the read and the context twice.
- **Recover in the program.** A `ToolCallError` you can handle — a missing optional file, one failing candidate path — belongs in a `try/catch` inside the program, not in another round-trip.
