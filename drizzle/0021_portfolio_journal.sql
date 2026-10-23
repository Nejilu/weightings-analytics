CREATE TABLE `portfolio_journal_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`portfolio_id` text NOT NULL,
	`captured_at` text NOT NULL,
	`kind` text NOT NULL,
	`patch_json` text NOT NULL,
	`value_usd` real,
	FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `portfolio_journal_portfolio_idx` ON `portfolio_journal_entries` (`portfolio_id`,`id`);