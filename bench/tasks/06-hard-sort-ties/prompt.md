`sortTodos` in `src/filter.ts` orders by priority but says nothing about ties, so
two `normal` todos come out in whatever order the engine felt like. We render this
list to users and it needs to be the same every time.

Give it a total order: priority first (high, normal, low), then `createdAt`
ascending, then `title` compared with `localeCompare`, then `id` ascending as the
last resort. Equal inputs in a different starting order must produce the same
output, and the function must still leave its input untouched.

Add tests for the tie-breaking, and keep the existing suite green.
