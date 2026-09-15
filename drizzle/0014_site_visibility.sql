ALTER TABLE etfs ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'weights', 'public'));
--> statement-breakpoint
UPDATE etfs SET visibility = CASE WHEN fund_type = 'portfolio' THEN 'private' WHEN fund_type = 'custom' THEN 'weights' ELSE 'public' END;
