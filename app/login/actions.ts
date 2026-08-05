"use server";

import { redirect } from "next/navigation";
import { requireEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

export async function requestMagicLink(formData: FormData) {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const { ADMIN_EMAIL, APP_BASE_URL } = requireEnv("ADMIN_EMAIL", "APP_BASE_URL");

  // Single-user allowlist per docs/PHASE_0_PLAN.md §3 — a non-matching
  // email gets the same "check your email" outcome as a real one
  // (no signInWithOtp call happens), so this isn't an account-
  // enumeration oracle.
  if (email !== ADMIN_EMAIL.toLowerCase()) {
    redirect("/login?sent=1");
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${APP_BASE_URL}/auth/callback` },
  });

  redirect(error ? "/login?error=1" : "/login?sent=1");
}
