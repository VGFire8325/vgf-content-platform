import { test } from "node:test";
import assert from "node:assert/strict";
import { PINTEREST_SCHEDULE_START_HOUR_UTC, pickCampaignDailySlot, pickFacebookSlot, pickLinkedInSlot, pickPinterestSlot } from "./scheduling";

test("pickPinterestSlot uses the start date when nothing is scheduled yet", () => {
  const start = new Date("2026-08-06T00:00:00Z");
  const slot = pickPinterestSlot({}, start);
  assert.equal(slot.toISOString().slice(0, 10), "2026-08-06");
  assert.equal(slot.getUTCHours(), PINTEREST_SCHEDULE_START_HOUR_UTC);
});

test("pickPinterestSlot offsets same-day slots by the spacing hours", () => {
  const start = new Date("2026-08-06T00:00:00Z");
  const slot = pickPinterestSlot({ "2026-08-06": 1 }, start, 2);
  assert.equal(slot.toISOString().slice(0, 10), "2026-08-06");
  assert.equal(slot.getUTCHours(), PINTEREST_SCHEDULE_START_HOUR_UTC + 6);
});

test("pickPinterestSlot rolls over to the next day once the daily cap is hit", () => {
  const start = new Date("2026-08-06T00:00:00Z");
  const slot = pickPinterestSlot({ "2026-08-06": 2 }, start, 2);
  assert.equal(slot.toISOString().slice(0, 10), "2026-08-07");
});

test("pickPinterestSlot skips multiple full days", () => {
  const start = new Date("2026-08-06T00:00:00Z");
  const slot = pickPinterestSlot({ "2026-08-06": 2, "2026-08-07": 2, "2026-08-08": 2 }, start, 2);
  assert.equal(slot.toISOString().slice(0, 10), "2026-08-09");
});

test("pickFacebookSlot schedules ~1 hour out when nothing has posted yet", () => {
  const now = new Date("2026-08-06T12:00:00Z");
  const slot = pickFacebookSlot(null, now);
  assert.equal(slot.getTime(), now.getTime() + 60 * 60 * 1000);
});

test("pickFacebookSlot schedules 7 days after the last post", () => {
  const last = new Date("2026-08-01T12:00:00Z");
  const now = new Date("2026-08-02T00:00:00Z");
  const slot = pickFacebookSlot(last, now);
  assert.equal(slot.toISOString(), "2026-08-08T12:00:00.000Z");
});

test("pickFacebookSlot never lands in the past after a long gap", () => {
  const last = new Date("2026-01-01T12:00:00Z"); // months ago
  const now = new Date("2026-08-06T12:00:00Z");
  const slot = pickFacebookSlot(last, now);
  assert.ok(slot.getTime() > now.getTime());
  assert.equal(slot.getTime(), now.getTime() + 60 * 60 * 1000);
});

// LinkedIn shares Facebook's weekly-cadence logic (see scheduling.ts) —
// same behavior, a separate export so each platform's schedule is
// tracked independently.
test("pickLinkedInSlot schedules ~1 hour out when nothing has posted yet", () => {
  const now = new Date("2026-08-06T12:00:00Z");
  const slot = pickLinkedInSlot(null, now);
  assert.equal(slot.getTime(), now.getTime() + 60 * 60 * 1000);
});

test("pickLinkedInSlot schedules 7 days after the last post", () => {
  const last = new Date("2026-08-01T12:00:00Z");
  const now = new Date("2026-08-02T00:00:00Z");
  const slot = pickLinkedInSlot(last, now);
  assert.equal(slot.toISOString(), "2026-08-08T12:00:00.000Z");
});

test("pickCampaignDailySlot schedules tomorrow when nothing in the campaign has posted yet", () => {
  const now = new Date("2026-09-01T12:00:00Z");
  const slot = pickCampaignDailySlot(null, now);
  assert.equal(slot.toISOString(), "2026-09-02T12:00:00.000Z");
});

test("pickCampaignDailySlot schedules 1 day after the campaign's last post", () => {
  const last = new Date("2026-09-02T12:00:00Z");
  const now = new Date("2026-09-02T18:00:00Z");
  const slot = pickCampaignDailySlot(last, now);
  assert.equal(slot.toISOString(), "2026-09-03T12:00:00.000Z");
});

test("pickCampaignDailySlot never lands in the past after a long gap", () => {
  const last = new Date("2026-08-01T12:00:00Z");
  const now = new Date("2026-09-01T00:00:00Z");
  const slot = pickCampaignDailySlot(last, now);
  assert.ok(slot.getTime() > now.getTime());
});
