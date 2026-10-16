import assert from "node:assert/strict";
import test from "node:test";
import { isCommercialRedisplayApproved } from "../lib/dataStore";
import { __newsTest } from "./news";

const source = {
  id: "licensed-test",
  name: "Licensed test source",
  icon: "📰",
  lang: "en" as const,
  cat: "global" as const,
  color: "#123456",
  url: "https://example.test/feed.xml",
  commercialRedisplay: {
    status: "approved" as const,
    evidence: "contract: test-only",
  },
};

test("a feed is inactive without documented commercial redisplay approval", () => {
  assert.equal(isCommercialRedisplayApproved({ ...source, commercialRedisplay: { status: "pending" } }), false);
  assert.equal(isCommercialRedisplayApproved(source), true);
});

test("news parser limits syndicated snippets and does not fabricate publish time", () => {
  const long = "x".repeat(400);
  const feed = `<?xml version="1.0"?><rss><channel><item>
    <title>Market title</title><link>https://example.test/story</link>
    <description>${long}</description>
  </item></channel></rss>`;
  const [item] = __newsTest.parseFeed(feed);
  assert.equal(item.title, "Market title");
  assert.equal(item.description.length, 280);
  assert.equal(item.pubDate, "");
});

test("news deduplication and server ranking keep one copy and prioritize urgent headlines", () => {
  const feeds = [
    {
      status: "ok" as const,
      meta: source,
      items: [
        {
          title: "شركة مصر تعلن نتائج جديدة",
          link: "https://example.test/a",
          description: "snippet",
          pubDate: "2026-10-15T10:00:00.000Z",
          guid: "a",
        },
      ],
    },
    {
      status: "ok" as const,
      meta: { ...source, id: "licensed-test-two", name: "Other licensed source" },
      items: [
        {
          title: "شركة مصر تعلن نتائج جديدة!",
          link: "https://example.test/duplicate",
          description: "same syndicated headline",
          pubDate: "2026-10-16T10:00:00.000Z",
          guid: "duplicate",
        },
        {
          title: "عاجل: قرار جديد للأسواق",
          link: "https://example.test/urgent",
          description: "short snippet",
          pubDate: "2026-10-14T10:00:00.000Z",
          guid: "urgent",
        },
      ],
    },
  ];

  const deduped = __newsTest.dedupeAndRankFeeds(feeds);
  const ranked = __newsTest.rankedItemsFromFeeds(deduped);
  assert.equal(ranked.length, 2);
  assert.equal(ranked.filter((item) => item.title.startsWith("شركة مصر")).length, 1);
  assert.equal(ranked[0]?.title, "عاجل: قرار جديد للأسواق");
  assert.equal(ranked[0]?.source.id, "licensed-test-two");
});
