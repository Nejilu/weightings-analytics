CREATE TEMP TABLE `_panx_adp_affected_snapshots` AS
SELECT DISTINCT `holdings`.`snapshot_id`
FROM `holdings`
INNER JOIN `holding_snapshots`
  ON `holding_snapshots`.`id` = `holdings`.`snapshot_id`
WHERE `holding_snapshots`.`etf_id` = 'panx-ucits'
  AND `holdings`.`security_id` = 'FR0010340141'
  AND UPPER(COALESCE(`holdings`.`source_ticker`, '')) = 'ADP';
--> statement-breakpoint
DELETE FROM `holdings`
WHERE `security_id` = 'FR0010340141'
  AND `snapshot_id` IN (SELECT `snapshot_id` FROM `_panx_adp_affected_snapshots`)
  AND EXISTS (
    SELECT 1
    FROM `holdings` AS `correct_holding`
    WHERE `correct_holding`.`snapshot_id` = `holdings`.`snapshot_id`
      AND `correct_holding`.`security_id` = 'US0530151036'
  );
--> statement-breakpoint
UPDATE `holdings` AS `target_holding`
SET
  `security_id` = 'US0530151036',
  `market_value` = (
    SELECT `source_holding`.`market_value`
    FROM `holding_snapshots` AS `target_snapshot`
    INNER JOIN `holding_snapshots` AS `source_snapshot`
      ON `source_snapshot`.`etf_id` = 'acwi-us'
      AND `source_snapshot`.`as_of` = `target_snapshot`.`as_of`
    INNER JOIN `holdings` AS `source_holding`
      ON `source_holding`.`snapshot_id` = `source_snapshot`.`id`
      AND `source_holding`.`security_id` = 'US0530151036'
    WHERE `target_snapshot`.`id` = `target_holding`.`snapshot_id`
    ORDER BY `source_snapshot`.`fetched_at` DESC
    LIMIT 1
  )
WHERE `target_holding`.`security_id` = 'FR0010340141'
  AND `target_holding`.`snapshot_id` IN (
    SELECT `snapshot_id` FROM `_panx_adp_affected_snapshots`
  )
  AND EXISTS (
    SELECT 1
    FROM `holding_snapshots` AS `target_snapshot`
    INNER JOIN `holding_snapshots` AS `source_snapshot`
      ON `source_snapshot`.`etf_id` = 'acwi-us'
      AND `source_snapshot`.`as_of` = `target_snapshot`.`as_of`
    INNER JOIN `holdings` AS `source_holding`
      ON `source_holding`.`snapshot_id` = `source_snapshot`.`id`
      AND `source_holding`.`security_id` = 'US0530151036'
      AND `source_holding`.`market_value` > 0
    WHERE `target_snapshot`.`id` = `target_holding`.`snapshot_id`
  );
--> statement-breakpoint
UPDATE `holdings` AS `target_holding`
SET `weight` = `target_holding`.`market_value` * 100.0 / (
  SELECT SUM(`component_holding`.`market_value`)
  FROM `holdings` AS `component_holding`
  WHERE `component_holding`.`snapshot_id` = `target_holding`.`snapshot_id`
)
WHERE `target_holding`.`snapshot_id` IN (
    SELECT `snapshot_id` FROM `_panx_adp_affected_snapshots`
  )
  AND NOT EXISTS (
    SELECT 1
    FROM `holdings` AS `invalid_holding`
    WHERE `invalid_holding`.`snapshot_id` = `target_holding`.`snapshot_id`
      AND (
        `invalid_holding`.`market_value` IS NULL
        OR `invalid_holding`.`market_value` <= 0
      )
  );
--> statement-breakpoint
UPDATE `holding_snapshots`
SET
  `row_count` = (
    SELECT COUNT(*)
    FROM `holdings`
    WHERE `holdings`.`snapshot_id` = `holding_snapshots`.`id`
  ),
  `total_weight` = (
    SELECT SUM(`holdings`.`weight`)
    FROM `holdings`
    WHERE `holdings`.`snapshot_id` = `holding_snapshots`.`id`
  )
WHERE `id` IN (SELECT `snapshot_id` FROM `_panx_adp_affected_snapshots`);
--> statement-breakpoint
DROP TABLE `_panx_adp_affected_snapshots`;
