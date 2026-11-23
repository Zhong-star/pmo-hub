# Issue #71 — native browser zoom validation

Validated on 2026-11-23 against `Zhong-star/pmo-hub`, branch
`codex/issue-71-native-zoom`, application SHA
`63096f25b18761d907af46ec9f077721b8fb8e98` (integrated main after PR #86).
This record changes no application code.

## Environment and method

Windows, Node 26.3.0, installed Google Chrome 157.0.8103.80 driven through Playwright and
Windows Computer Use. Three Vite frontends, three compiled Nest APIs, a continuous
Resource Allocation worker, and separate disposable PostgreSQL 17 databases.
Migrations were explicitly applied before API startup. Resource Allocation used
the first-Admin, minimal-record, and optional demo preparation commands.

All browser journeys used `http://127.0.0.1:5273/`, with Hub proxying the two
modules and their APIs. This was a temporary development session, not a deployment
of this SHA to the existing local cluster.

Native Chrome Ctrl-plus changed zoom through 110%, 125%, 150%, 175%, and **200%**.
Windows accessibility exposed `Zoom: 200%`; the native toolbar popup also displayed
200%. At unchanged window size (1266 × 953 physical pixels including browser
chrome), the page reported `innerWidth = 632`, `devicePixelRatio = 2`.
Neither CSS zoom nor a reduced Playwright viewport was used for this check.

## Observed results

- Inspected Requests, New request, Request queues, Allocations and capacity,
  Notifications, and Administration in light and dark themes. All twelve layout
  measurements had document/client width 632 px, without horizontal page overflow.
- The responsive `Module menu` exposed all six destinations. Enter opened it;
  Tab focused Requests; Enter navigated and closed it. Focus outlines were visible
  and measured 2 CSS px: `rgb(24, 104, 219)` in light and `rgb(138, 184, 255)` in dark.
- Inspected rendered controls, labels, state text, and action contrast in both
  themes. The automated visual-alignment cases also passed their rendered
  contrast assertions. This is a scoped inspection, not a complete WCAG audit.
- Filled a real request for ITDM-LOCAL-001, Platform Engineering / Software
  Engineer, 2026-12-07 through 2026-12-18, 12 weekly hours. Review and Send remained
  reachable at 200%. Submission `ca80bfa5-dba8-40b6-b128-d7847c0e5f3c` completed
  with one succeeded line, zero failed, zero pending; request
  `812f00a6-cb22-4094-b0fe-1ec70d822c58` appeared in WAITING_FOR_PRESENTATION.
- Navigated Resource Allocation → Hub → Lessons Learned → Hub → Resource
  Allocation on the same origin. Both themes propagated across the applications;
  the final native Chrome control still reported 200%.
- Wide administrative/review tables retain internal horizontal scrolling. Their
  data and actions remain reachable; the containing page does not scroll sideways.
  Vertical scrolling is required at this zoom. Native Windows captures were used
  for inspection because Playwright screenshots cropped incorrectly at native zoom.

## Regression on the application SHA above

| Command | Result |
| --- | --- |
| `npm run build` | Passed all workspaces; generated OpenAPI/client files unchanged |
| `npm run check:fast` | Lint and typecheck passed; 193/194 tests passed initially, one Lessons Learned Votes test failed |
| `npm run test --workspace @pmo-hub/lessons-learned -- tests/Votes.test.tsx` | Isolated rerun: 6/6 passed |
| `npm test -- --maxWorkers=2` in `apps/lessons-learned/` | Full rerun: 154/154 passed; other workspace results from check:fast remain 12 Hub, 6 Hub API, 8 Lessons Learned API, 14 Resource Allocation API |
| `npm run test:e2e --workspace @pmo-hub/resource-allocation -- --workers=1` | 111/111 passed, including visual/contrast cases |
| `npm run test:e2e --workspace @pmo-hub/hub -- --workers=1` | 11/11 passed |

The first sandbox attempts hit spawn EPERM; process-enabled reruns produced the
results above. The initial Votes failure did not reproduce in the isolated or
full limited-worker rerun; its cause was not established. Build retains the
existing Resource Allocation bundle advisory (about 546 kB).

## Acceptance and provenance

This closes the native-zoom gap in
[#71's prior validation](https://github.com/Zhong-star/pmo-hub/issues/71#issuecomment-7063492199).
That comment's 98 PostgreSQL/HTTP tests, 73 browser tests, worker stop/recovery,
and performance measurements belong to `555dde7`, an ancestor of this application
SHA. They were not rerun or remeasured here. AC-31, AC-47 and AC-50 retain that
historical evidence; AC-43 adds the native zoom inspection and current regression
above. PR #86's 111 browser tests had previously covered the later visual changes;
this session repeated those tests on integrated main.

Supporting source, native captures, zoom accessibility tree, layout metrics, and
keyboard measurements are retained in the workspace at
`.scratch/issue-71-native-zoom/`. Historical specification and measurement details
remain in `planning/resource-allocation/.specs/features/request-decision-allocation/`.
These are evidence references only; application runtime has no dependency on them.
