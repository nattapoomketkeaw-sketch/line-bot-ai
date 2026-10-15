import crypto from "node:crypto";
import {
  HANDOFF_TAG,
  askGemini,
  kvGet,
  kvSet,
  loadHistory,
  loadServiceData,
  alertOwnerOnce,
  notifyOwner,
  saveHistory,
} from "../lib/core.js";

// Endpoint for Make.com: Make receives the Messenger/Instagram message and POSTs it here,
// then sends the returned "reply" back to the customer. Same rules, Sheet data and handoff as the other channels.
//
// Request  (header x-make-secret must equal env MAKE_SECRET):
//   { "text": "...", "userId": "<sender id>", "platform": "messenger" | "instagram", "mid": "<message id, optional>" }
//   { "action": "owner_replied", "userId": "...", "platform": "..." }   -> bot goes silent for that customer
// Response: { "reply": "<text to send>", "send": true|false, "handoff": true|false }
//   send=false means "do not send anything" (handed off, duplicate, or empty).
const { MAKE_SECRET } = process.env;
const MAKE_ALLOW_ALL = process.env.MAKE_ALLOW_ALL === "true"; // test mode: ignore earlier handoff silence

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function authorized(given) {
  if (!MAKE_SECRET || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(MAKE_SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function POST(request) {
  if (!authorized(request.headers.get("x-make-secret"))) return json({ error: "unauthorized" }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const userId = String(body.userId || "").trim();
  const platform = body.platform === "instagram" ? "instagram" : "messenger";
  if (!userId) return json({ error: "userId required" }, 400);
  const key = `meta:${platform}:${userId}`;
  const label = platform === "instagram" ? "Instagram" : "Messenger";

  if (body.action === "owner_replied") {
    await kvSet(`handoff:${key}`, "1");
    return json({ reply: "", send: false, handoff: true });
  }

  const text = String(body.text || "").trim();
  if (!text) {
    return json({
      reply: "ขอบคุณที่ส่งมาค่ะ ตอนนี้ตอบได้เฉพาะข้อความ พิมพ์ถามเรื่องแพ็กเกจ ราคา หรือเงื่อนไขได้เลยนะคะ",
      send: true,
      handoff: false,
    });
  }

  if (body.mid) {
    if (await kvGet(`mid:${body.mid}`)) return json({ reply: "", send: false, handoff: false }); // retried delivery
    await kvSet(`mid:${body.mid}`, "1", 600);
  }

  if (!MAKE_ALLOW_ALL && (await kvGet(`handoff:${key}`))) {
    console.log(`skip ${key}: handed off to owner`);
    return json({ reply: "", send: false, handoff: true });
  }

  try {
    const data = await loadServiceData();
    const history = await loadHistory(key);
    history.push({ role: "user", text });
    let answer =
      (await askGemini(history, data)) || "ขออภัยค่ะ ตอนนี้ตอบไม่ได้ ทีมงานจะติดต่อกลับโดยเร็วนะคะ";

    let handoff = false;
    const tag = answer.match(HANDOFF_TAG);
    if (tag) {
      handoff = true;
      answer = answer.replace(HANDOFF_TAG, "").trim();
      await kvSet(`handoff:${key}`, "1");
      await notifyOwner(`🔔 ลูกค้าจาก ${label} (Make) รอให้คุณคุยต่อ\nสรุป: ${tag[1].trim() || "-"}\nkey: ${key}`);
    }

    history.push({ role: "model", text: answer });
    await saveHistory(key, history);
    return json({ reply: answer.slice(0, 1900), send: true, handoff });
  } catch (err) {
    console.error(err);
    await alertOwnerOnce(
      "bot-error",
      `บอทตอบลูกค้าไม่ได้ (${String(err.message).slice(0, 160)}) กรุณาตอบลูกค้าเองใน LINE OA / Messenger`,
    );
    return json({
      reply: "ขออภัยค่ะ ระบบขัดข้องชั่วคราว ทีมงานจะติดต่อกลับโดยเร็วนะคะ",
      send: true,
      handoff: false,
    });
  }
}
