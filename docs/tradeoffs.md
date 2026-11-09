# Trade-offs and limits

Draft for the README's trade-offs section (Milestone 7). Each entry says what
the harness cannot do, why, and what would close the gap.

## 1. A wrong value inside its bounds passes a shape check

Model output is never compared exactly; it is checked against its declared
shape (type, required, length or range bounds, allowed values). Values
computed from model output keep bounds derived from their inputs: in
`invoice-total`, the total must fall between 0 and 54,125.

So a defect that keeps a value inside its bounds goes unnoticed. If the engine
added 1 to the tax on a model-extracted amount, the total would still be in
range and the test would pass. Derived ranges grow with each step, so the
further a value is from the model, the less its shape says.

The deterministic parts are still checked exactly: in the same workflow the
tax rate comes from the mock API and is compared to the last digit. And when
a condition reads model output, each branch narrows the value's range (the
auto-route branch requires confidence of at least 0.75), so taking the wrong
branch fails the shape check even though either screen is valid on its own.

What would close it: relational checks between tainted values (total = net +
tax, whatever net was), or an LLM-as-judge for free-text output.

## 2. Optional model fields can be absent

A contract can mark a field optional, and the simulated model leaves optional
fields out on some seeds, as real models do. A page that displays such a
field has nothing to show on those seeds.

`invoice-extraction` displays one (the due date). The app marks a missing
optional value with `data-absent` instead of failing the run. The harness
checks its shape when it is present and, when it is not, records a coverage
gap with the reason and the seed. That keeps the test honest, but a single
seed only ever covers one of the two cases; repeated runs with different seeds
(the variance runs in `npm run prove`) are what cover both.

## 3. A fetch that depends on model output can't be replayed

The mirror predicts a `fetch` by replaying the same GET against the mock API.
If the URL is built from model output (say, a customer id the model
extracted), the mirror doesn't know the URL, so it can't replay the request.
The response is treated as unknown: anything read from it is tainted with no
shape beyond "present", and the mirror can't predict whether the request will
fail.

No shipped workflow does this. What would close it: an observed-fetch mode
that reads the URL the app actually requested (from a request log or a
data attribute) and replays that, the same way observed routing reads the
branch the app actually took.

## 4. With a fixed seed, identical runs get identical IDs

Generated IDs are derived from `AI_SEED`, the step and the run's own state,
on a random stream separate from the model's. That is what lets a seed
reproduce a failing run exactly, references included, even when tests run in
parallel and in a different order.

The cost: two runs with the same seed and the same inputs produce the same
reference. In `order-confirmation`, two identical orders placed against one
server get the same `ORD-…` number. Tests never notice, because each case
runs once per seed and references are only shape-checked, but it is not how
a real system may behave.

What would close it: mix a per-run nonce into the ID stream and record it
next to the seed, so reproduction needs both. Or take uniqueness from a
store, which this demo deliberately doesn't have.
