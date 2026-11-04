/** Synthetic SQLite producer used only by native integration tests; owns the supplied temporary database. */
import { DatabaseSync } from "node:sqlite";
import { createInterface } from "node:readline";
const database = new DatabaseSync(process.argv[2]);
const modes = new Map([
  ["wal", "PRAGMA journal_mode=WAL"],
  ["delete", "PRAGMA journal_mode=DELETE"],
  ["truncate", "PRAGMA journal_mode=TRUNCATE"],
  ["persist", "PRAGMA journal_mode=PERSIST"],
]);
const mode = modes.get(process.argv[3]);
if (!mode) throw new Error("Unknown synthetic journal mode");
database.exec(mode);
database.exec(
  "PRAGMA user_version=1; CREATE TABLE items(id INTEGER PRIMARY KEY, value INTEGER); INSERT INTO items VALUES(1,7)",
);
console.log("ready");
for await (const command of createInterface({ input: process.stdin })) {
  if (command === "update") {
    database.exec("UPDATE items SET value=8");
    console.log("updated");
  } else if (command === "begin-write") {
    database.exec("BEGIN IMMEDIATE; UPDATE items SET value=8");
    console.log("writing");
  } else if (command === "lock") {
    database.exec("BEGIN EXCLUSIVE");
    console.log("locked");
  } else if (command === "unlock") {
    database.exec("ROLLBACK");
    console.log("unlocked");
  } else if (command === "close") {
    database.close();
    console.log("closed");
    break;
  } else throw new Error("Unknown synthetic writer command");
}
if (database.isOpen) database.close();
