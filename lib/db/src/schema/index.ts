import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";

export const pairSnapshots = pgTable("pair_snapshots", {
  pairId: text("pair_id").primaryKey(),
  data: jsonb("data").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});

// trading_pairs is the authoritative list of pairs tracked by the dashboard.
// Seeded with 22 defaults on first server start; extendable via POST /api/arb/pairs.
export const tradingPairs = pgTable("trading_pairs", {
  pairId: text("pair_id").primaryKey(),
  name: text("name").notNull(),
  bitmexSymbol: text("bitmex_symbol").notNull(),
  hlSymbol: text("hl_symbol").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PairSnapshot = typeof pairSnapshots.$inferSelect;
export type PairSnapshotInsert = typeof pairSnapshots.$inferInsert;
export type TradingPair = typeof tradingPairs.$inferSelect;
export type TradingPairInsert = typeof tradingPairs.$inferInsert;
