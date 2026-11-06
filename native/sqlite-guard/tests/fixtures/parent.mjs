/** Test-only parent/producer: inherits a control pipe whose writer remains owned by the Rust grandparent. */
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const database = new DatabaseSync(process.argv[3]);
database.exec(
  "PRAGMA user_version=1; CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO items VALUES(1,'fixture'); BEGIN EXCLUSIVE",
);
const env = {};
for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP"])
  if (process.env[key] !== undefined) env[key] = process.env[key];
const helper = spawn(
  process.argv[2],
  ["--parent-pid", String(process.pid), "--lifetime-ms", "3000"],
  {
    env,
    stdio: [0, 1, 2],
  },
);
helper.once("error", () => {
  throw new Error("Could not start fixture helper");
});
helper.once("exit", (code) => {
  database.close();
  process.exit(code ?? 1);
});
