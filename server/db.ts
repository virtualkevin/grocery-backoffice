import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
export function openDatabase(
  path = process.env.DB_PATH ?? "data/produce.sqlite",
) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
  );
  db.exec(`CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, generation INTEGER NOT NULL,status TEXT NOT NULL, snapshot TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS intents(run_id TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL,reserved INTEGER NOT NULL CHECK(reserved>=0),PRIMARY KEY(run_id,id));
 CREATE TABLE IF NOT EXISTS stock(run_id TEXT NOT NULL,supplier_id TEXT NOT NULL,sku_id TEXT NOT NULL,quantity INTEGER NOT NULL CHECK(quantity>=0),floor_cents INTEGER NOT NULL,PRIMARY KEY(run_id,supplier_id,sku_id));
 CREATE TABLE IF NOT EXISTS purchases(run_id TEXT NOT NULL,intent_id TEXT NOT NULL,quote_id TEXT NOT NULL,cost INTEGER NOT NULL CHECK(cost>=0),quantity INTEGER NOT NULL CHECK(quantity>0),PRIMARY KEY(run_id,intent_id));
 CREATE TABLE IF NOT EXISTS events(run_id TEXT NOT NULL,seq INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(run_id,seq));
 CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL);`);
  return db;
}
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
