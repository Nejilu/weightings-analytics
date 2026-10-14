import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

test("cache migration retains the newest usable data and leaves portfolio history intact", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  try {
    const folder = resolve("drizzle");
    const journal = JSON.parse(readFileSync(resolve(folder, "meta/_journal.json"), "utf8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    for (const entry of journal.entries.filter((entry) => entry.idx < 19)) {
      db.exec(readFileSync(resolve(folder, `${entry.tag}.sql`), "utf8").replaceAll("--> statement-breakpoint", ""));
    }
    db.exec(`
      INSERT INTO benchmarks (id, name, provider) VALUES ('test', 'Test', 'Test');
      INSERT INTO etfs (id,ticker,isin,name,issuer,benchmark_id,wrapper,domicile,exchange,trading_currency,distribution_policy,product_url,holdings_url,fund_type)
        VALUES ('test-etf','TEST','TEST','Test','Test','test','UCITS','US','Test','USD','Acc','test','test','physical');
      INSERT INTO portfolios (id,name) VALUES ('saved','Saved');
      INSERT INTO portfolio_value_snapshots (portfolio_id,date,captured_at,value_usd,value_eur,eur_to_usd,quotes_as_of,fx_as_of,reason)
        VALUES ('saved','2026-10-01','2026-10-01',100,90,1.1,'2026-10-01','2026-10-01','initial'),
               ('saved','2026-10-02','2026-10-02',110,100,1.1,'2026-10-02','2026-10-02','scheduled');
      INSERT INTO securities (id,name) VALUES ('s','Security');
      INSERT INTO metric_definitions (id,key,name,entity_type,value_type)
        VALUES ('security:eps_estimate_series:v1','eps_estimate_series','EPS','security','json'),
               ('security:price_to_book:v1','price_to_book','P/B','security','number');
    `);
    const metric = db.prepare(`INSERT INTO metric_observations
      (id,metric_definition_id,entity_type,entity_id,as_of,value_number,value_json,captured_at)
      VALUES (?,?,'security','s',?,?,?,?)`);
    const series = {
      providerSymbol: "NASDAQ:TEST", currency: "USD", price: 100,
      points: Array.from({ length: 8 }, (_, index) => ({ fiscalPeriod: `Q${index}`, estimate: index + 1,
        isHistorical: index < 4, estimateDate: null, analystCount: 10 })),
    };
    metric.run('eps-good','security:eps_estimate_series:v1','2026-10-01',null,JSON.stringify(series),'2026-10-01T00:00:00Z');
    metric.run('eps-bad','security:eps_estimate_series:v1','2026-10-02',null,JSON.stringify({ ...series, points: [] }),'2026-10-02T00:00:00Z');
    metric.run('pb-old','security:price_to_book:v1','2026-10-01',1,null,'2026-10-01T00:00:00Z');
    metric.run('pb-new','security:price_to_book:v1','2026-10-02',2,null,'2026-10-02T00:00:00Z');
    for (const [id, date] of [['old','2026-10-01'],['new','2026-10-02']]) {
      db.prepare(`INSERT INTO holding_snapshots (id,etf_id,as_of,fetched_at,source_url,source_status,total_weight,row_count)
        VALUES (?,'test-etf',?,?,'test','live',100,5)`).run(id,date,date);
      for (let i = 0; i < 5; i++) {
        db.prepare('INSERT OR IGNORE INTO securities (id,name) VALUES (?,?)').run(`h${i}`,`Holding ${i}`);
        db.prepare('INSERT INTO holdings (snapshot_id,security_id,weight) VALUES (?, ?, 20)').run(id,`h${i}`);
      }
    }
    db.exec(readFileSync(resolve(folder, '0019_outstanding_supreme_intelligence.sql'), 'utf8').replaceAll('--> statement-breakpoint',''));
    assert.deepEqual(db.prepare('SELECT id FROM metric_observations ORDER BY id').all(), [{id:'eps-good'},{id:'pb-new'}]);
    assert.deepEqual(db.prepare('SELECT id FROM holding_snapshots').all(), [{id:'new'}]);
    assert.deepEqual(db.prepare('SELECT count(*) AS n FROM holdings').get(), {n:5});
    assert.deepEqual(db.prepare('SELECT count(*) AS n FROM portfolio_value_snapshots').get(), {n:2});
    assert.throws(() => metric.run('pb-duplicate','security:price_to_book:v1','2026-10-03',3,null,'2026-10-03T00:00:00Z'), /UNIQUE/);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
  }
});
