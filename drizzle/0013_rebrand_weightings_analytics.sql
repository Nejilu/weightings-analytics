UPDATE `benchmarks`
SET `provider` = 'Weightings Analytics'
WHERE `provider` = ('Index' || 'Lens');
--> statement-breakpoint
UPDATE `etfs`
SET `issuer` = 'Weightings Analytics'
WHERE `issuer` = ('Index' || 'Lens');
--> statement-breakpoint
UPDATE `etfs`
SET `exchange` = 'Weightings Analytics'
WHERE `exchange` = ('Index' || 'Lens');
