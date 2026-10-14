CREATE TABLE `application_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `portfolio_dividend_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`portfolio_id` text NOT NULL,
	`security_id` text NOT NULL,
	`provider_symbol` text NOT NULL,
	`ex_date` text NOT NULL,
	`value_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`security_id`) REFERENCES `securities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `portfolio_dividend_payment_event_uq` ON `portfolio_dividend_payments` (`portfolio_id`,`security_id`,`ex_date`);--> statement-breakpoint
CREATE TABLE `portfolio_dividend_tracking` (
	`portfolio_id` text PRIMARY KEY NOT NULL,
	`started_at` text NOT NULL,
	FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `portfolio_security_balances` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`portfolio_id` text NOT NULL,
	`security_id` text NOT NULL,
	`effective_at` text NOT NULL,
	`quantity` real,
	`provider_symbol` text,
	FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`security_id`) REFERENCES `securities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `portfolio_security_balances_lookup_idx` ON `portfolio_security_balances` (`portfolio_id`,`security_id`,`effective_at`);--> statement-breakpoint
CREATE TABLE `security_dividend_observations` (
	`security_id` text PRIMARY KEY NOT NULL,
	`provider_symbol` text NOT NULL,
	`value_json` text NOT NULL,
	`captured_at` text NOT NULL,
	`retry_after` text,
	FOREIGN KEY (`security_id`) REFERENCES `securities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Start ownership tracking now; never manufacture historical entitlement.
INSERT INTO portfolio_dividend_tracking (portfolio_id, started_at)
SELECT id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM portfolios;
--> statement-breakpoint
INSERT INTO portfolio_security_balances (portfolio_id, security_id, effective_at, quantity, provider_symbol)
SELECT p.portfolio_id, p.security_id, t.started_at, p.quantity, p.price_symbol
FROM portfolio_items p JOIN portfolio_dividend_tracking t ON t.portfolio_id = p.portfolio_id
WHERE p.asset_type = 'security';
