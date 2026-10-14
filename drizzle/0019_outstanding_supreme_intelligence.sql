-- Keep usable cache entries before collapsing the former daily history.
DELETE FROM metric_observations
WHERE metric_definition_id = 'security:eps_estimate_series:v1'
  AND CASE WHEN COALESCE(json_valid(value_json), 0) = 0 THEN 1 ELSE
    NOT COALESCE(
      json_type(value_json, '$.providerSymbol') = 'text'
      AND length(trim(json_extract(value_json, '$.providerSymbol'))) > 0
      AND json_type(value_json, '$.currency') = 'text'
      AND length(trim(json_extract(value_json, '$.currency'))) > 0
      AND json_type(value_json, '$.price') IN ('integer','real')
      AND json_extract(value_json, '$.price') > 0
      AND json_type(value_json, '$.points') = 'array'
      AND json_array_length(value_json, '$.points') = 8
      AND (SELECT count(DISTINCT trim(json_extract(p.value, '$.fiscalPeriod')))
           FROM json_each(value_json, '$.points') p WHERE p.type = 'object') = 8
      AND NOT EXISTS (
        SELECT 1 FROM json_each(value_json, '$.points') p
        WHERE CASE WHEN p.type <> 'object' THEN 1 ELSE NOT COALESCE(
          json_type(p.value, '$.fiscalPeriod') = 'text'
          AND length(trim(json_extract(p.value, '$.fiscalPeriod'))) > 0
          AND json_type(p.value, '$.estimate') IN ('integer','real')
          AND json_type(p.value, '$.isHistorical') = CASE WHEN p.key < 4 THEN 'true' ELSE 'false' END
          AND (json_type(p.value, '$.estimateDate') = 'null' OR
               (json_type(p.value, '$.estimateDate') = 'text' AND julianday(json_extract(p.value, '$.estimateDate')) IS NOT NULL))
          AND (json_type(p.value, '$.analystCount') = 'null' OR
               (json_type(p.value, '$.analystCount') IN ('integer','real') AND json_extract(p.value, '$.analystCount') >= 0))
        , 0) END
      )
    , 0) END;
--> statement-breakpoint
DELETE FROM metric_observations WHERE id IN (
  SELECT id FROM (
    SELECT id, row_number() OVER (
      PARTITION BY metric_definition_id, entity_type, entity_id
      ORDER BY captured_at DESC, as_of DESC, id DESC
    ) AS position FROM metric_observations
  ) WHERE position > 1
);
--> statement-breakpoint
DROP INDEX `metric_observations_natural_uq`;
--> statement-breakpoint
CREATE UNIQUE INDEX `metric_observations_natural_uq` ON `metric_observations` (`metric_definition_id`,`entity_type`,`entity_id`);
--> statement-breakpoint
-- Keep the latest usable composition, after validating row counts. Legacy
-- custom definitions without stored selections still need their anchor;
-- leave those alone until their definition is migrated and refreshed.
DELETE FROM holding_snapshots WHERE id IN (
  WITH candidates AS (
    SELECT s.id, s.etf_id, row_number() OVER (
      PARTITION BY s.etf_id ORDER BY s.fetched_at DESC, s.as_of DESC, s.id DESC
    ) AS position
    FROM holding_snapshots s JOIN etfs e ON e.id = s.etf_id
    WHERE s.row_count = (SELECT count(*) FROM holdings h WHERE h.snapshot_id = s.id)
      AND s.row_count >= CASE s.etf_id
        WHEN 'acwi-us' THEN 2000 WHEN 'bgsix-us' THEN 50
        WHEN 'csemas-ucits' THEN 500 ELSE CASE WHEN e.fund_type = 'physical' THEN 5 ELSE 1 END END
      AND (e.fund_type <> 'custom' OR CASE WHEN json_valid(e.metadata_json)
        THEN COALESCE(json_array_length(e.metadata_json, '$.selectedSecurities'), 0) > 0 ELSE 0 END)
  )
  SELECT s.id FROM holding_snapshots s
  WHERE EXISTS (SELECT 1 FROM candidates c WHERE c.etf_id = s.etf_id)
    AND NOT EXISTS (SELECT 1 FROM candidates c WHERE c.id = s.id AND c.position = 1)
);
