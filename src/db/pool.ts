import { Pool } from "pg";
import { config } from "../config";

function enforceSslMode(url: string): string {
  if (!url) return url;
  const u = new URL(url);
  u.searchParams.set("sslmode", "verify-full");
  return u.toString();
}

export const pool = new Pool({
  connectionString: enforceSslMode(config.databaseUrl),
});
