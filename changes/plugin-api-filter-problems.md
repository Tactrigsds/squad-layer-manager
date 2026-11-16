---
audience: operators
kind: breaking
---

A plugin of your own that calls `slm/systems/layer-queries` must handle filters that cannot be applied through `problems`, and its manifest must declare plugin API 0.23. `query`, `componentValues`, `outOfPool` and `itemStatuses` no longer return `err:invalid-node`. A constraint whose filter cannot be applied is left out of the query, and the result lists it in `problems` (`statuses.problems` for `itemStatuses`), so a query on that filter alone matches every layer. `genVote` returns `err:invalid-choices` in place of `err:invalid-node`, with the index of each choice whose own constraints cannot be applied. A layer in a `query` or `genVote` result holds `null` in `constraints` for each constraint the query left out or did not evaluate, where it used to hold `false`.

Each error names the stored filter it is in and the path to the failing node. `describeNodeValidationError` in `slm/models/filter` writes one as a log line. The plugin guide's "Layer queries" section describes the new results. The tt-slm-plugins set ships an updated release alongside this one.
