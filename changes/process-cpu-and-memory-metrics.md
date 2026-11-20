---
audience: operators
kind: added
minor: true
---

With telemetry on, SLM exports its own CPU time and memory, and the bundled Grafana overview dashboard shows them in a new Process row.

The metrics are `process.cpu.time` and `process.memory.usage`, the container's memory split into anonymous memory and page cache (`slm.cgroup.memory.usage`), and the memory held by each worker thread's heap and by the layer engine. Use them to choose the CPU and RAM to give SLM.
