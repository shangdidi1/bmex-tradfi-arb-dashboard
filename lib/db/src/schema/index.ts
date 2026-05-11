import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";

export const pairSnapshots = pgTable("pair_snapshots", {
  pairId: text("pair_id").primaryKey(),
  data: jsonb("data").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PairSnapshot = typeof pairSnapshots.$inferSelect;
export type PairSnapshotInsert = typeof pairSnapshots.$inferInsert;
