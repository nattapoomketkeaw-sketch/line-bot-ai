import crypto from "node:crypto";
import { waitUntil } from "@vercel/functions";
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
  startWaiting,
  stopWaiting,
  waitingAck,
  handoffNotice,
} from "../lib/core.js";

// Facebook Messenger + Instagram DM webhook (Meta Messenger Platform).
const {
  META_APP_SECRET,
  META_VERIFY_TOKEN,
  META_PAGE_ACCESS_TOKEN,
  META_APP_ID, // optional: lets us tell the bot's own echoes from the owner's manual replies
  META_GRAPH_VERSION = "v23.0",
} = process.env;
// Default: answer only brand-new conversations. true = answer everyone (handy for testing).
const META_ALLOW_ALL = process.env.META_ALLOW_ALL === "true";

const GRAPH = `https://graph.facebook.com/${META_GRAPH_VERSION}`;
const PLATFORM = { page: "messenger", instagram: "instagram" };

function verifySignature(rawBody, signatureHeader) {
  if (!signatureHeader || !META_APP_SECRET) return false;
  const expected = crypto.createHmac("sha256", META_APP_SECRET).update(rawBody).digest("hex");
  const given = signatureHeader.replace(/^sha256=/, "");
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function graph(path, init = {}) {
  const res = await fetch(`${GRAPH}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${META_PAGE_ACCESS_TOKEN}`,
    },
  });
  if (!res.ok) throw new Error(`Graph ${path} failed ${res.status}: ${await res.text()}`);
  return res.json();
}

async function sendText(userId, text) {
  const json = await graph("/me/messages", {
    method: "POST",
    body: JSON.stringify({
      recipient: { id: userId },
      messaging_type: "RESPONSE",
      message: { text: text.slice(0, 1900) },
    }),
  });
  // Remember our own message id so its echo is not mistaken for the owner replying by hand.
  if (json.message_id) await kvSet(`botmid:${json.message_id}`, "1", 3600);
}

async function typing(userId) {
  try {
    await graph("/me/messages", {
      method: "POST",
      body: JSON.stringify({ recipient: { id: userId }, sender_action: "typing_on" }),
    });
  } catch {
    /* cosmetic only */
  }
}

// A conversation with more than this one message means the owner (or the customer earlier)
// already has a chat going, so the bot stays out of it.
async function isNewConversation(object, userId) {
  const qs = new URLSearchParams({
    platform: PLATFORM[object],
    user_id: userId,
    fields: "message_count",
  });
  const json = await graph(`/me/conversations?${qs}`);
  const count = json.data?.[0]?.message_count;
  return count === undefined ? true : count <= 1;
}

async function handleMessaging(object, event) {
  const msg = event.message;

  // Echo = a message sent BY the page. If it was not ours, the owner is chatting by hand: go silent.
  if (msg?.is_echo) {
    const key = `meta:${object}:${event.recipient?.id}`;
    const own = (META_APP_ID && String(msg.app_id) === META_APP_ID) || (await kvGet(`botmid:${msg.mid}`));
    if (!own) {
      console.log(`owner replied by hand to ${key}: bot goes silent`);
      await kvSet(`handoff:${key}`, "1");
      await stopWaiting(key); // owner answered: stop reminders and reassurance
    }
    return;
  }
  if (!msg || !event.sender?.id) return; // read receipts, postbacks, etc.

  if (msg.mid) {
    if (await kvGet(`mid:${msg.mid}`)) return; // Meta retried a delivery we already handled
    await kvSet(`mid:${msg.mid}`, "1", 600);
  }

  const userId = event.sender.id;
  const key = `meta:${object}:${userId}`;
  const label = object === "instagram" ? "Instagram" : "Messenger";

  if (!META_ALLOW_ALL && !(await kvGet(`active:${key}`)) && !(await kvGet(`handoff:${key}`))) {
    let fresh;
    try {
      fresh = await isNewConversation(object, userId);
    } catch (err) {
      console.error("conversation check failed (staying silent)", err);
      return;
    }
    if (!fresh) {
      console.log(`skip ${key}: existing conversation (owner's chat)`);
      return void (await kvSet(`handoff:${key}`, "1"));
    }
    await kvSet(`active:${key}`, "1");
  }
  // META_ALLOW_ALL is a test mode: it also ignores earlier handoff/owner-reply silence.
  if (!META_ALLOW_ALL && (await kvGet(`handoff:${key}`))) {
    console.log(`skip ${key}: handed off to owner`);
    const ack = await waitingAck(key);
    if (ack) await sendText(userId, ack).catch((err) => console.error("wait ack failed", err));
    return;
  }

  try {
    if (!msg.text) {
      // Attachments/stickers: stay silent so the bot never talks over the owner mid-chat.
      console.log(`skip ${key}: non-text message`);
      return await alertOwnerOnce(`media:${key}`, `ลูกค้า Messenger/IG (${key}) ส่งรูป/ไฟล์มา บอทไม่ตอบ กรุณาดูในแชท`);
    }
    await typing(userId);
    const data = await loadServiceData();
    const history = await loadHistory(key);
    history.push({ role: "user", text: msg.text });
    let answer =
      (await askGemini(history, data)) ||
      "ขออภัยค่ะ ตอนนี้ตอบไม่ได้ ทีมงานจะติดต่อกลับโดยเร็วนะคะ";

    const tag = answer.match(HANDOFF_TAG);
    if (tag) {
      answer = answer.replace(HANDOFF_TAG, "").trim();
      await kvSet(`handoff:${key}`, "1");
      const summary = tag[1].trim();
      await startWaiting(key, { channel: "meta", to: userId, label, name: "", summary });
      await notifyOwner(handoffNotice({ label, name: "", summary, key }));
    }

    history.push({ role: "model", text: answer });
    await saveHistory(key, history);
    await sendText(userId, answer);
  } catch (err) {
    console.error(err);
    await alertOwnerOnce("bot-error", `บอทตอบลูกค้าไม่ได้ (${String(err.message).slice(0, 160)}) กรุณาตอบลูกค้าเองใน LINE OA / Messenger`);
    try {
      await sendText(userId, "ขออภัยค่ะ ระบบขัดข้องชั่วคราว ทีมงานจะติดต่อกลับโดยเร็วนะคะ");
    } catch {
      /* nothing more we can do */
    }
  }
}

// Meta calls this once when you save the webhook in the app dashboard.
export async function GET(request) {
  const q = new URL(request.url).searchParams;
  if (q.get("hub.mode") === "subscribe" && META_VERIFY_TOKEN && q.get("hub.verify_token") === META_VERIFY_TOKEN) {
    return new Response(q.get("hub.challenge") || "", { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

export async function POST(request) {
  const rawBody = await request.text();
  if (!verifySignature(rawBody, request.headers.get("x-hub-signature-256"))) {
    return new Response("Invalid signature", { status: 401 });
  }
  const body = JSON.parse(rawBody);
  // Meta wants a 200 within 20 seconds and re-sends otherwise: acknowledge right away and
  // let the (slower) Gemini work finish in the background after the response is sent.
  if (PLATFORM[body.object]) {
    waitUntil(
      (async () => {
        for (const entry of body.entry || []) {
          for (const event of entry.messaging || []) {
            await handleMessaging(body.object, event);
          }
        }
      })().catch((err) => console.error("meta background processing failed", err)),
    );
  }
  return new Response("EVENT_RECEIVED");
}
