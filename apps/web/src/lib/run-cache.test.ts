import { describe, expect, it } from "vitest";

import { touchRunCache } from "./run-cache";

describe("run diagnostic cache", () => {
  it("evicts the least recently used run deterministically", () => {
    let cache: Record<string, number> = {};
    cache = touchRunCache(cache, "run-a", 1, 3);
    cache = touchRunCache(cache, "run-b", 2, 3);
    cache = touchRunCache(cache, "run-c", 3, 3);
    cache = touchRunCache(cache, "run-a", cache["run-a"]!, 3);
    cache = touchRunCache(cache, "run-d", 4, 3);

    expect(cache).toEqual({ "run-c": 3, "run-a": 1, "run-d": 4 });
  });
});
