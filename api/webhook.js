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
  startWaiting,
  stopWaiting,
  findWaiting,
  waitingAck,
  getLineName,
  handoffNotice,
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
      await stopWaiting(resume[1]);
      return reply(event.replyToken, `เปิดบอทให้ลูกค้า ${resume[1]} กลับมาตอบแล้ว`);
    }
    // Owner command: "/done <code>" = I answered this customer, stop reminding me and reassuring them.
    const done = text.match(/^\/done(?:\s+(\S+))?$/i);
    if (done && OWNER_LINE_USER_ID && userId === OWNER_LINE_USER_ID) {
      const keys = await findWaiting(done[1]);
      for (const k of keys) await stopWaiting(k);
      return reply(
        event.replyToken,
        keys.length ? `หยุดติดตามแล้ว ${keys.length} ราย` : "ไม่พบลูกค้าที่รอ (พิมพ์ /done <รหัส> หรือ /done all)",
      );
    }
    // Existing customers (no follow event since go-live) are the owner's own chats: stay out.
    if (!BOT_ALLOW_ALL && !(await kvGet(`active:${userId}`))) {
      console.log(`skip ${userId}: existing LINE friend (no follow event since go-live)`);
      return;
    }
    // Owner has taken over this chat: stay silent for good so the bot never talks over them.
    // BOT_ALLOW_ALL is a test mode: it also ignores earlier handoff silence.
    if (!BOT_ALLOW_ALL && (await kvGet(`handoff:${userId}`))) {
      console.log(`skip ${userId}: handed off to owner`);
      const ack = await waitingAck(userId);
      if (ack) await reply(event.replyToken, ack);
      return;
    }

    if (!isText) {
      // Stickers/images/files: stay silent so the bot never talks over the owner mid-chat.
      // Images/files may need a human, so tell the owner (stickers are ignored).
      console.log(`skip ${userId}: non-text message (${event.message.type})`);
      if (event.message.type !== "sticker") {
        const name = await getLineName(userId);
        await alertOwnerOnce(
          `media:${userId}`,
          `ลูกค้า LINE ${name || userId} ส่ง${event.message.type === "image" ? "รูป" : "ไฟล์/ข้อความที่ไม่ใช่ตัวอักษร"}มา บอทไม่ตอบ กรุณาดูในแชท`,
        );
      }
      return;
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
      const name = await getLineName(userId);
      const summary = tag[1].trim();
      await startWaiting(userId, { channel: "line", to: userId, label: "LINE", name, summary });
      await notifyOwner(handoffNotice({ label: "LINE", name, summary, key: userId }));
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
