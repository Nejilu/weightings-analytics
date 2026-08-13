CREATE TABLE `portfolio_cash_positions` (
	`portfolio_id` text NOT NULL,
	`currency` text NOT NULL,
	`amount` real NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`portfolio_id`, `currency`),
	FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `portfolio_cash_positions_portfolio_idx` ON `portfolio_cash_positions` (`portfolio_id`);
