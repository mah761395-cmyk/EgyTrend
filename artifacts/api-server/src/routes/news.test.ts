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

test("RSS outbound guard blocks loopback, private DNS, credentials and non-public IPv6", async () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.8",
    "169.254.169.254",
    "100.64.0.1",
    "192.168.1.7",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(__newsTest.isPublicIpAddress(address), false, `${address} must not be a feed target`);
  }
  assert.equal(__newsTest.isPublicIpAddress("1.1.1.1"), true);
  assert.equal(__newsTest.isPublicIpAddress("2606:4700:4700::1111"), true);

  await assert.rejects(() => __newsTest.assertSafeFeedUrl("http://127.0.0.1:8080/feed"), /rss_target_not_allowed/);
  await assert.rejects(() => __newsTest.assertSafeFeedUrl("https://user:pass@example.test/feed"), /rss_target_not_allowed/);
  await assert.rejects(
    () => __newsTest.assertSafeFeedUrl("https://feed.example.test/rss", async () => [{ address: "10.1.2.3", family: 4 }]),
    /rss_target_not_allowed/,
  );
  const publicUrl = await __newsTest.assertSafeFeedUrl(
    "https://feed.example.test/rss",
    async () => [{ address: "93.184.216.34", family: 4 }],
  );
  assert.equal(publicUrl.hostname, "feed.example.test");
});

test("RSS redirects are manually revalidated before a second request", async () => {
  const resolver = async () => [{ address: "93.184.216.34", family: 4 as const }];
  const unsafeVisits: string[] = [];
  await assert.rejects(
    () => __newsTest.fetchSafeFeed(
      "https://feed.example.test/rss",
      {},
      resolver,
      async (url) => {
        unsafeVisits.push(url);
        return new Response("", { status: 302, headers: { location: "http://127.0.0.1/admin" } });
      },
    ),
    /rss_target_not_allowed/,
  );
  assert.deepEqual(unsafeVisits, ["https://feed.example.test/rss"], "the internal redirect must never be fetched");

  const safeVisits: string[] = [];
  const response = await __newsTest.fetchSafeFeed(
    "https://feed.example.test/rss",
    {},
    resolver,
    async (url) => {
      safeVisits.push(url);
      return safeVisits.length === 1
        ? new Response("", { status: 302, headers: { location: "/next.xml" } })
        : new Response("<rss/>", { status: 200, headers: { "content-type": "application/rss+xml" } });
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(safeVisits, ["https://feed.example.test/rss", "https://feed.example.test/next.xml"]);
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
