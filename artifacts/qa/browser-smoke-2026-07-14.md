# Clean-vault browser smoke — 2026-07-14

Evidence class: **operator-observed, no-cost local product diagnostic**. This is not live-provider, real-Keychain, competitor, or independent accessibility evidence.

## Environment

- macOS local source supervisor, Node.js 22.22.3
- clean temporary Continuum data directory
- production web build served by the local API
- deterministic mock provider; API spend USD 0.00
- in-app Chromium browser

## Observed journey

1. Authenticated bootstrap completed and redirected to the connected local origin.
2. All four onboarding screens rendered and were operable:
   - the finite-model/infinite-history boundary was stated explicitly;
   - Keychain-only storage and the USD 100 hard cap were disclosed;
   - local-versus-provider data boundaries, `store: false`, and no product telemetry were disclosed;
   - exact provenance, corrections, deletion, and the immutable demo-preview option were disclosed.
3. Onboarding was completed without a provider key. The canonical conversation opened with zero retained events.
4. The user message “Please remember that my preferred project codename is Cedar Lantern, and tell me what you stored.” completed through the real API/worker path:
   - two events were retained;
   - the assistant response exposed its exact user-turn source chip;
   - the completion notification reported 94 input tokens and USD 0.000.
5. Unified local search for “Cedar Lantern” returned five results in 2 ms: the exact user event, one current claim, its compiled topic/page views, and the exact assistant event. The deterministic assistant echo did **not** create an assistant-authored claim or topic.
6. The answer-specific memory inspector refreshed from the completed debug endpoint and showed:
   - one candidate and one selected source;
   - ordered source identifiers;
   - packet hash `d85d71cb2bae71f8f52a9cb96e322ec54c62bd302e7782ff59f607bfe6dafa99`;
   - “Exact rendered packet — verified from references” rather than the earlier incomplete cached snapshot;
   - response and memory calls, completed background compilation, the unspent USD 100 budget, and schema/retrieval/reranker/model versions.
7. The live knowledge-graph drawer rendered the focused topic/claim neighborhood, an evidence-backed relationship, the exact topic summary, and an evidence navigation control.
8. Browser cleanup closed the test tab. A separate real supervisor start/stop smoke confirmed that the private runtime descriptor was removed after graceful shutdown.

## Outcome and boundaries

The clean no-cost personal-chat journey passed, including the two regressions found during the prior browser pass: false assistant-memory attribution and stale answer-debug hydration. No browser console error was observed during the earlier full-surface pass; this final focused pass did not retain a console export or screenshot. Real OpenAI connectivity, macOS Keychain save/read/delete, live first-token latency, black-box competitor behavior, and a third-party WCAG audit remain separate release evidence.
