---
audience: users
kind: added
---

Filters that cannot be applied are marked wherever they are used, with the reason and a link to the failing condition.

- The queue dashboard lists each filter of the server's configuration that cannot be applied, and what the configuration uses it for.
- A queued layer is marked when a filter could not be checked against it.
- The layer table names the filters that cannot be applied to its results, beside the result count. The summary view marks each of those filters.
- The vote generation dialog names the filters its choices were generated without. The Fix Repeats message names them too.
- A layer request whose own filter cannot be applied is marked in the layer requests panel.
- The filter list, the applied filters and the filter pickers mark each filter that cannot be applied.
- The filter editor marks each condition that cannot be applied and lists the problems above the filter. Select a problem to jump to its condition. A problem in a referenced filter links to the failing condition in that filter.
- A filter that cannot be applied can still be saved, with a warning that counts its problems.
