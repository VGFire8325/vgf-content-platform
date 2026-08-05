import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireEnv } from "./env";

const BUCKET = "content-assets";

// Lazy for the same reason as db/client.ts: importing this module must
// not require real Supabase credentials at build/import time.
let cachedClient: SupabaseClient | null = null;
function getClient(): SupabaseClient {
  if (!cachedClient) {
    const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = requireEnv("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY");
    cachedClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  }
  return cachedClient;
}

export async function uploadRenderedImage(buffer: Buffer, path: string): Promise<string> {
  const client = getClient();
  const { error } = await client.storage.from(BUCKET).upload(path, buffer, {
    contentType: "image/png",
    upsert: true,
  });
  if (error) {
    throw new Error(`Supabase Storage upload failed: ${error.message}`);
  }
  const { data } = client.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}
