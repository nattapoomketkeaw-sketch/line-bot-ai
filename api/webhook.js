import crypto from "node:crypto";
import {
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
  stopWaiting,
  findWaiting,
  getLineName,
  isWaiting,
  requestOwner,
  processHandoff,
  ownerTookOver,
  WAITING_NOTE,
  SILENT_TAG,
  checkPaymentSlip,
  slipSummary,
  SLIP_THANKS,
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
    const id = event.source.userId;
    // Quiet mode (owner: "/quiet"): new friends are customers the owner brought over from another
    // channel to coordinate, so the bot stays out. "/resume <id>" turns the bot on for one of them.
    if (!BOT_ALLOW_ALL && (await kvGet("quiet"))) {
      const name = await getLineName(id);
      console.log(`skip ${id}: follow during quiet mode`);
      await notifyOwner(`🔕 โหมดเงียบ: ${name || "ลูกค้า"} เพิ่มเพื่อนใหม่ บอทไม่ตอบ\nถ้าเป็นลูกค้าใหม่ที่ต้องการให้บอทตอบ พิมพ์ /resume ${id}`);
      return;
    }
    await kvSet(`active:${id}`, "1");
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
    // Owner command: "/quiet [hours]" (default 24) = new LINE friends are NOT answered by the bot; "/quiet off" ends it.
    const quiet = text.match(/^\/quiet(?:\s+(\S+))?$/i);
    if (quiet && OWNER_LINE_USER_ID && userId === OWNER_LINE_USER_ID) {
      if (/^off$/i.test(quiet[1] || "")) {
        await kvDel("quiet");
        return reply(event.replyToken, "ปิดโหมดเงียบแล้ว ลูกค้าใหม่ที่เพิ่มเพื่อนบอทจะตอบตามปกติ");
      }
      const hours = Math.min(Math.max(parseFloat(quiet[1]) || 24, 0.1), 168);
      await kvSet("quiet", "1", Math.round(hours * 3600));
      return reply(
        event.replyToken,
        `เปิดโหมดเงียบ ${hours} ชม. เพื่อนใหม่ที่แอดเข้ามาบอทจะไม่ตอบ (พิมพ์ /quiet off เพื่อปิด)`,
      );
    }
    // Owner command: "/done <code>" = I answered this customer: stop reminders and make the bot silent for them.
    // (LINE sends no event when the owner replies in OA Manager, so this is how the bot learns the owner took over.)
    const done = text.match(/^\/done(?:\s+(\S+))?$/i);
    if (done && OWNER_LINE_USER_ID && userId === OWNER_LINE_USER_ID) {
      const keys = await findWaiting(done[1]);
      for (const k of keys) await ownerTookOver(k);
      return reply(
        event.replyToken,
        keys.length
          ? `หยุดติดตามและปิดบอทสำหรับลูกค้า ${keys.length} ราย แล้ว (พิมพ์ /resume <key> ถ้าอยากเปิดบอทอีกครั้ง)`
          : "ไม่พบลูกค้าที่รอ (พิมพ์ /done <รหัส> หรือ /done all)",
      );
    }
    // Existing customers (no follow event since go-live) are the owner's own chats: stay out.
    if (!BOT_ALLOW_ALL && !(await kvGet(`active:${userId}`))) {
      console.log(`skip ${userId}: existing LINE friend (no follow event since go-live)`);
      return;
    }
    // Owner has taken over this chat (/done, or waited 24h with no answer): stay silent so the bot never talks over them.
    // Customers merely waiting for the owner are NOT silenced: the bot keeps answering what it can.
    // BOT_ALLOW_ALL is a test mode: it also ignores earlier handoff silence.
    if (!BOT_ALLOW_ALL && (await kvGet(`handoff:${userId}`))) {
      console.log(`skip ${userId}: owner took over`);
      return;
    }
    const lineInfo = { channel: "line", to: userId, label: "LINE", name: () => getLineName(userId) };

    if (!isText) {
      // Stickers/images/files: stay silent so the bot never talks over the owner mid-chat.
      // Images/files may need a human, so tell the owner (stickers are ignored).
      if (event.message.type === "image") {
        // A payment slip = booking confirmation: check it, then hand the customer to the owner for good.
        const img = await fetch(`https://api-data.line.me/v2/bot/message/${event.message.id}/content`, {
          headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
        });
        const slip = img.ok
          ? await checkPaymentSlip(Buffer.from(await img.arrayBuffer()), img.headers.get("content-type") || "image/jpeg")
          : null;
        if (slip?.isSlip) {
          await requestOwner(userId, lineInfo, slipSummary(slip), "(บอทตรวจจากรูปเท่านั้น กรุณาเช็กยอดเข้าบัญชีเอง)");
          return reply(event.replyToken, SLIP_THANKS);
        }
      }
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
    // While waiting for the owner the bot keeps answering, but stays quiet on plain thanks/acknowledgements.
    const waiting = await isWaiting(userId);
    let answer =
      (await askGemini(history, data, waiting ? WAITING_NOTE : "")) ||
      "ขออภัยค่ะ ตอนนี้ตอบไม่ได้ ทีมงานจะติดต่อกลับโดยเร็วนะคะ";
    if (SILENT_TAG.test(answer)) {
      console.log(`skip ${userId}: acknowledgement while waiting for owner`);
      return;
    }
    answer = await processHandoff(userId, answer, lineInfo);

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
