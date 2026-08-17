import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { parseCronExpression } from "../src/cron-expression";

test("parses and normalizes the supported five-field syntax", () => {
  const parsed = parseCronExpression("*/15 9-17 * JAN,JUN MON-FRI");
  assert.equal(parsed.trigger, "calendar");
  if (parsed.trigger !== "calendar") {
    assert.fail("expected a calendar schedule");
  }

  assert.deepEqual(parsed.minute.values, [0, 15, 30, 45]);
  assert.deepEqual(parsed.hour.values, [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual(parsed.month.values, [1, 6]);
  assert.deepEqual(parsed.dayOfWeek.values, [1, 2, 3, 4, 5]);
  assert.equal(parsed.normalized, "0,15,30,45 9,10,11,12,13,14,15,16,17 * 1,6 1,2,3,4,5");
});

test("supports nicknames, full names, lists, ranges, and Sunday aliases", () => {
  assert.equal(parseCronExpression("@annually").normalized, "0 0 1 1 *");
  assert.equal(parseCronExpression("0 2 * January Sunday,7").normalized, "0 2 * 1 0");
  assert.equal(parseCronExpression("5/20 * * * *").normalized, "5,25,45 * * * *");
  assert.equal(parseCronExpression("0 0 15 * 0-6").normalized, "0 0 15 * 0,1,2,3,4,5,6");
  const wildcard = parseCronExpression("0 0 */1 * MON");
  assert.equal(wildcard.trigger === "calendar" && wildcard.dayOfMonth.wildcard, true);
});

test("supports reboot and login as aliases for user scheduler startup", () => {
  const reboot = parseCronExpression("@reboot");
  const login = parseCronExpression("@LOGIN");

  assert.deepEqual(reboot, { trigger: "startup", normalized: "@reboot" });
  assert.deepEqual(login, reboot);
});

test("rejects malformed, out-of-range, and six-field expressions", () => {
  assert.throws(() => parseCronExpression("0 0 * *"), /expected 5 fields/);
  assert.throws(() => parseCronExpression("0 0 0 * *"), /between 1 and 31/);
  assert.throws(() => parseCronExpression("0 0 * * 5-1"), /ascending/);
  assert.throws(() => parseCronExpression("0 0 0 * * *"), /seconds are not supported/);
  assert.throws(() => parseCronExpression("*/0 * * * *"), /positive integer/);
  assert.throws(() => parseCronExpression("*/1e1 * * * *"), /positive integer/);
  assert.throws(() => parseCronExpression("*/0x10 * * * *"), /positive integer/);
});
