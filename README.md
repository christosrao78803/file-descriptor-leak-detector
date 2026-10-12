# file-descriptor-leak-detector

Wraps `fs.open` and `fs.close` so a test suite can assert that no file descriptors leaked past a configurable threshold.

```js
import { LeakDetector } from 'file-descriptor-leak-detector';

const det = new LeakDetector({ threshold: 0 });
const handle = await det.open('/etc/hosts', 'r');
// ...use handle...
await det.close(handle);

det.checkLeaks(); // throws if any tracked descriptor is still open
```

## Why

Process-level fd limits are large enough that a handful of forgotten descriptors won't crash a short-lived program, which is exactly why they accumulate in long-running tests and CI. This library exists so a test can fail loudly on the run that opened the descriptor, instead of failing with a cryptic `EMFILE` on some later run.

The detector wraps `node:fs/promises` `open`/`close` rather than patching the global `fs` module. That means only descriptors opened through the detector are tracked — if the code under test calls `fs.openSync` directly, those are invisible to it. This is the deliberate trade-off: no monkey-patching means no surprising side effects in unrelated tests.

## Edge

`checkLeaks` reads live descriptors via a `WeakRef` to the `FileHandle`. A handle that has gone out of scope but not yet been GC-closed is not reported as a leak, because Node will reclaim it. The flip side: if your test opens a file and drops the handle without calling `close`, this detector will **not** flag it. It catches descriptors you are still holding a reference to, not descriptors awaiting GC.

The `now` option exists so tests can pass a deterministic clock instead of asserting on wall-clock `openedAt` values.

## API

- `new LeakDetector({ threshold?, now? })` — `threshold` (default `0`) is the maximum number of simultaneously open descriptors allowed before `checkLeaks` throws; `now` (default `Date.now`) is the clock used to record `openedAt`.
- `async det.open(path, flags, mode)` — wraps `fs/promises.open`, records the fd.
- `async det.close(handle)` — wraps `fs/promises.close`, clears the fd record.
- `det.checkLeaks()` — returns an array of open descriptor descriptors (`{ fd, path, flags, openedAt }`); throws if the count exceeds `threshold`.
- `det.getOpenDescriptors()` — returns the same array without throwing.
- `det.getOpenCount()` — returns the integer count of live tracked descriptors.
- `async det.cleanup()` — closes every still-tracked descriptor best-effort and returns what was closed.
