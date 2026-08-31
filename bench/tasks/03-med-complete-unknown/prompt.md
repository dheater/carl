`src/complete-unknown.test.ts` is failing. `TodoStore.complete` silently does
nothing when handed an id the store does not hold, which hid a real bug for weeks.

Make the test pass by fixing `complete`, not by changing the test. `remove` has
the same hole — give it the same treatment, and keep the rest of the suite green.
