import { describe, expect, it } from "vitest";
import { __rateLimitObserverForTests } from "./rate-limit-observer.js";

describe("rate-limit-observer", () => {
  describe("parseProviderRateLimitDetail", () => {
    it("parses per-minute input token limits", () => {
      const parsed = __rateLimitObserverForTests.parseProviderRateLimitDetail(
        '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your organization\'s rate limit of 30,000 input tokens per minute"}}',
      );
      expect(parsed).toEqual({
        limit: 30_000,
        unit: "input tokens",
        window: "minute",
      });
    });

    it("parses per-day request limits", () => {
      const parsed = __rateLimitObserverForTests.parseProviderRateLimitDetail(
        "Rate limit of 250 requests per day reached",
      );
      expect(parsed).toEqual({
        limit: 250,
        unit: "requests",
        window: "day",
      });
    });

    it("returns undefined when detail is absent", () => {
      const parsed = __rateLimitObserverForTests.parseProviderRateLimitDetail("Connection timeout");
      expect(parsed).toBeUndefined();
    });
  });
});
