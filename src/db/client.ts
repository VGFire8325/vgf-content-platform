import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// Lazy on purpose: Next.js imports every route module during build-time
// page-data collection, which must succeed without real secrets present.
// The connection (and the "DATABASE_URL is not set" check) only happens
// on first actual query, at request time.
type Db = ReturnType<typeof drizzle<typeof schema>>;
let _db: Db | null = null;

function getDb(): Db {
  if (!_db) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set");
    }
    const client = postgres(connectionString, { prepare: false });
    _db = drizzle(client, { schema });
  }
  return _db;
}

export const db: Db = new Proxy({} as Db, {
  get(_target, prop, receiver) {
    return Reflect.get(getDb() as object, prop, receiver);
  },
});
