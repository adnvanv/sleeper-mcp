/**
 * Offline tests for get_transaction_feed logic. Run after `npm run build`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTransactionFeed, ordinal } from "../dist/transaction-feed.js";

const players = new Map([
  ["a", { first_name: "Al", last_name: "Adams", position: "WR", team: "KC" }],
  ["b", { first_name: "Bo", last_name: "Banks", position: "RB", team: "NE" }],
  ["c", { first_name: "Cy", last_name: "Cole", position: "TE", team: "SF" }],
]);
const rosters = [
  { roster_id: 1, owner_id: "u1" },
  { roster_id: 2, owner_id: "u2" },
];
const users = [
  { user_id: "u1", display_name: "Ann", metadata: { team_name: "Aces" } },
  { user_id: "u2", display_name: "Bea" },
];

const txns = [
  {
    transaction_id: "w1",
    type: "waiver",
    status: "complete",
    roster_ids: [1],
    adds: { a: 1 },
    drops: { c: 1 },
    settings: { waiver_bid: 12 },
    leg: 3,
    created: 3000,
  },
  {
    transaction_id: "f1",
    type: "waiver",
    status: "failed",
    roster_ids: [2],
    adds: { a: 2 },
    leg: 3,
    created: 2500,
  },
  {
    transaction_id: "t1",
    type: "trade",
    status: "complete",
    roster_ids: [1, 2],
    adds: { b: 1, c: 2 },
    drops: { b: 2, c: 1 },
    draft_picks: [
      {
        season: "2027",
        round: 2,
        roster_id: 1,
        previous_owner_id: 1,
        owner_id: 2,
      },
    ],
    waiver_budget: [{ sender: 2, receiver: 1, amount: 5 }],
    leg: 2,
    created: 2000,
  },
  {
    transaction_id: "fa1",
    type: "free_agent",
    status: "complete",
    roster_ids: [2],
    drops: { a: 2 },
    leg: 1,
    created: 1000,
  },
];

test("keeps completed moves only, newest first", () => {
  const { items } = buildTransactionFeed(txns, rosters, users, players);
  assert.deepEqual(
    items.map((i) => i.transaction_id),
    ["w1", "t1", "fa1"],
  );
});

test("waiver summary includes FAAB bid and drops", () => {
  const { items } = buildTransactionFeed(txns, rosters, users, players);
  assert.equal(
    items[0].summary,
    "Aces added Al Adams (WR, KC) ($12) and dropped Cy Cole (TE, SF)",
  );
  assert.equal(items[0].faab_bid, 12);
});

test("trade summary covers players, picks and FAAB on both sides", () => {
  const { items } = buildTransactionFeed(txns, rosters, users, players);
  const trade = items[1];
  assert.equal(
    trade.summary,
    "Trade: Aces gets Bo Banks (RB, NE), $5 FAAB; Bea gets Cy Cole (TE, SF), 2027 2nd (from Aces)",
  );
});

test("drop-only free agent move", () => {
  const { items } = buildTransactionFeed(txns, rosters, users, players);
  assert.equal(items[2].summary, "Bea dropped Al Adams (WR, KC)");
});

test("counts by type and by team", () => {
  const { counts, by_team } = buildTransactionFeed(
    txns,
    rosters,
    users,
    players,
  );
  assert.deepEqual(counts, { waiver: 1, trade: 1, free_agent: 1 });
  assert.deepEqual(by_team, [
    { team_name: "Aces", moves: 2 },
    { team_name: "Bea", moves: 2 },
  ]);
});

test("duplicate transactions across weeks are listed once", () => {
  const { items } = buildTransactionFeed(
    [...txns, txns[0]],
    rosters,
    users,
    players,
  );
  assert.equal(items.length, 3);
});

test("ordinal handles teens", () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal), [
    "1st",
    "2nd",
    "3rd",
    "4th",
    "11th",
    "12th",
    "13th",
    "21st",
    "22nd",
  ]);
});
