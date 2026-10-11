import { index, integer, boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const pastes = pgTable(
  "pastes",
  {
    id: text("id").primaryKey(),
    title: text("title"),
    content: text("content").notNull(),
    language: text("language").notNull().default("plain"),
    // "code" | "markdown"
    format: text("format").notNull().default("code"),
    burn: boolean("burn").notNull().default(false),
    passwordHash: text("password_hash"),
    manageToken: text("manage_token").notNull(),
    views: integer("views").notNull().default(0),
    sizeBytes: integer("size_bytes").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("pastes_expires_idx").on(t.expiresAt)],
);

export type PasteRow = typeof pastes.$inferSelect;
