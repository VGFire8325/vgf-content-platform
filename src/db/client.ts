import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// DATABASE_URL is the Supabase connection string (pooled, port 6543 for
// serverless/edge; direct 5432 connection for migrations). Server-side
// only — never exposed to the client bundle.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const client = postgres(connectionString, { prepare: false });
export const db = drizzle(client, { schema });
