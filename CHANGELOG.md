# Changelog

Until 1.0, a minor version may change the API or the format of `__limits__` files.

## 0.1.0

First release.

- `zs.measure`: frame times, input latency per gesture phase and main-thread CPU time
  of a scenario, the median of several runs, checked against limits recorded the first
  time, like a snapshot. A scenario over its limits is CPU-profiled once more, and its
  failure names the functions that took the time.
- `zs.cycles`: what a repeated cycle leaves behind in the JS heap, the DOM and event
  listeners.
- `zs.drag` and `zs.frame`, to pace scripted input like a person.
- Limits belong to the machine that recorded them. `-u` only lowers them;
  `ZS_ALLOW_WORSE=1` accepts a slower scenario.
- Scenarios whose page logs errors fail as `ERROR`, and their numbers never set limits.
- `zerospikes/reporter` and `npx zerospikes`: each scenario's history in the terminal,
  with keys to run the suite, lower limits and accept slower scenarios.
- `npx zerospikes compare`: two served builds measured in alternating sessions on the
  same machine, for CI.
- `zerospikes/app` (experimental): measure a running Tauri (Windows) or Electron app over
  the DevTools Protocol.
