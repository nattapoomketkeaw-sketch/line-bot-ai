import crypto from "node:crypto";
import {
  HANDOFF_TAG,
  BOT_ALLOW_ALL,
  OWNER_LINE_USER_ID,
  askGemini,
  kvDel,
  kvGet,
  kvSet,
  loadHistory,
  loadServiceData,
  alertOwnerOnce,
  notifyOwner,
  saveHistory,
} from "../lib/core.js";

const { LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN } = process.env;

function verifySignature(rawBody, signature) {
  if (!signature) return false;
  const expected = crypto
    .createHmac("sha256", LINE_CHANNEL_SECRET)
    .update(rawBody)
    .digest();
  const given = Buffer.from(signature, "base64");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

async function reply(replyToken, text) {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text: text.slice(0, 4900) }],
    }),
  });
  if (!res.ok) console.error("LINE reply failed", res.status, await res.text());
}

async function handleEvent(event) {
  if (event.type === "follow" && event.source?.userId) {
    await kvSet(`active:${event.source.userId}`, "1");
    return;
  }
  if (event.type !== "message" || !event.replyToken) return;
  try {
    const userId = event.source?.userId || "anonymous";
    const isText = event.message.type === "text";
    const text = isText ? event.message.text.trim() : "";

    if (text === "/myid") return reply(event.replyToken, `userId: ${userId}`);
    // Owner command: "/resume <userId>" lets the bot answer that customer again.
    const resume = text.match(/^\/resume\s+(\S+)$/);
    if (resume && OWNER_LINE_USER_ID && userId === OWNER_LINE_USER_ID) {
      await kvDel(`handoff:${resume[1]}`);
      await kvSet(`active:${resume[1]}`, "1");
      return reply(event.replyToken, `เปิดบอทให้ลูกค้า ${resume[1]} กลับมาตอบแล้ว`);
    }
    // Existing customers (no follow event since go-live) are the owner's own chats: stay out.
    if (!BOT_ALLOW_ALL && !(await kvGet(`active:${userId}`))) {
      console.log(`skip ${userId}: existing LINE friend (no follow event since go-live)`);
      return;
    }
    // Owner has taken over this chat: stay silent for good so the bot never talks over them.
    if (await kvGet(`handoff:${userId}`)) {
      console.log(`skip ${userId}: handed off to owner`);
      return;
    }

    if (!isText) {
      return reply(event.replyToken, "ขอบคุณที่ส่งมาค่ะ ตอนนี้ตอบได้เฉพาะข้อความ พิมพ์ถามเรื่องแพ็กเกจ ราคา หรือเงื่อนไขได้เลยนะคะ");
    }

    const data = await loadServiceData();
    const history = await loadHistory(userId);
    history.push({ role: "user", text });
    let answer =
      (await askGemini(history, data)) ||
      "ขออภัยค่ะ ตอนนี้ตอบไม่ได้ ทีมงานจะติดต่อกลับโดยเร็วนะคะ";

    const tag = answer.match(HANDOFF_TAG);
    if (tag) {
      answer = answer.replace(HANDOFF_TAG, "").trim();
      await kvSet(`handoff:${userId}`, "1");
      const note = `🔔 ลูกค้ารอให้คุณคุยต่อ
สรุป: ${tag[1].trim() || "-"}
userId: ${userId}`;
      await notifyOwner(note);
    }

    history.push({ role: "model", text: answer });
    await saveHistory(userId, history);
    await reply(event.replyToken, answer);
  } catch (err) {
    console.error(err);
    await alertOwnerOnce("bot-error", `บอทตอบลูกค้าไม่ได้ (${String(err.message).slice(0, 160)}) กรุณาตอบลูกค้าเองใน LINE OA / Messenger`);
    await reply(event.replyToken, "ขออภัยค่ะ ระบบขัดข้องชั่วคราว ทีมงานจะติดต่อกลับโดยเร็วนะคะ");
  }
}

export async function GET() {
  return new Response("LINE bot is running");
}

export async function POST(request) {
  const rawBody = await request.text();
  if (!verifySignature(rawBody, request.headers.get("x-line-signature"))) {
    return new Response("Invalid signature", { status: 401 });
  }
  const { events = [] } = JSON.parse(rawBody);
  await Promise.all(events.map(handleEvent));
  return new Response("OK");
}
