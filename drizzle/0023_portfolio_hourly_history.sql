CREATE TABLE `portfolio_hourly_history_settings` (
	`portfolio_id` text PRIMARY KEY NOT NULL,
	`slot_at` text,
	`last_attempt_at` text,
	`last_error` text,
	FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `portfolio_hourly_snapshots` (
	`portfolio_id` text NOT NULL,
	`slot_at` text NOT NULL,
	`date` text NOT NULL,
	`captured_at` text NOT NULL,
	`value_usd` real NOT NULL,
	`value_eur` real NOT NULL,
	`eur_to_usd` real NOT NULL,
	`quotes_as_of` text NOT NULL,
	`fx_as_of` text NOT NULL,
	`reason` text NOT NULL,
	`invested_json` text,
	PRIMARY KEY(`portfolio_id`, `slot_at`),
	FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "portfolio_hourly_positive_values" CHECK("portfolio_hourly_snapshots"."value_usd" > 0 AND "portfolio_hourly_snapshots"."value_eur" > 0 AND "portfolio_hourly_snapshots"."eur_to_usd" > 0)
);
--> statement-breakpoint
CREATE INDEX `portfolio_hourly_retention_idx` ON `portfolio_hourly_snapshots` (`slot_at`);