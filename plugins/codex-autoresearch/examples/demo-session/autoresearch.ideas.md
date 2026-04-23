# Autoresearch Ideas: Indexing Pipeline Speed and Memory Footprint Optimization

- Test whether shard planner warmup can drop rebuild time again without reintroducing crashes.
- Check whether manifest reuse can hold the latest score while shaving another few megabytes off peak memory.
- Validate the kept path against recall and correctness before treating the current lane as ready to promote.
