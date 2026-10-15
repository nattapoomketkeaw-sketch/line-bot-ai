import { runFollowups } from "../lib/core.js";

// Called every ~10 minutes by a scheduler (.github/workflows/followup.yml).
// It only does what is already due (per-customer timers live in Redis), so calling it extra is harmless.
// If CRON_SECRET is set in Vercel, the caller must send "Authorization: Bearer <secret>".
export async function GET(request) {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const result = await runFollowups();
  return Response.json(result);
}
