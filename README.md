# LINE Bot AI — Feeling writes a life

LINE chatbot ตอบลูกค้าเรื่องแพ็กเกจ Cinema/Photo โดยใช้ Gemini 3.8 Flash อ่านข้อมูลจาก Google Sheet (CSV) รันบน Vercel

## โครงสร้าง
- `api/webhook.js` — webhook (ตรวจ signature → อ่านชีท → ถาม Gemini → ตอบกลับทาง LINE)
- `packages.csv` — ข้อมูลต้นแบบ นำเข้า Google Sheet แล้ว "เผยแพร่ไปยังเว็บ" เป็น CSV

## ตั้งค่า Environment Variables (Vercel → Settings → Environment Variables)
| Key | ที่มา |
|---|---|
| `LINE_CHANNEL_SECRET` | LINE Developers → Basic settings → Channel secret |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Developers → Messaging API → Issue |
| `GEMINI_API_KEY` | Google AI Studio → API keys |
| `SHEET_CSV_URL` | ลิงก์ `.../pub?output=csv` ของ Google Sheet |

## Deploy
1. push โค้ดขึ้น GitHub แล้ว import repo ใน Vercel (หรือเชื่อมไว้แล้ว deploy อัตโนมัติ)
2. ตั้งค่า env ข้างบน แล้ว Redeploy
3. LINE Developers → Messaging API → Webhook URL = `https://<โดเมนของคุณ>.vercel.app/api/webhook` → Verify → เปิด **Use webhook**
4. LINE Official Account Manager → ปิด "ข้อความตอบกลับอัตโนมัติ" (Auto-reply) เพื่อไม่ให้ตีกับบอท

## อัปเดตข้อมูล
แก้ใน Google Sheet ได้เลย บอทดึงข้อมูลใหม่ภายใน ~1 นาที ไม่ต้อง deploy ใหม่

## ความปลอดภัย
อย่า commit token/secret ลง GitHub — ใช้ env ของ Vercel เท่านั้น (`.gitignore` กัน `.env` และ `Note.txt` ไว้แล้ว)

## Facebook Messenger + Instagram DM (Meta)
`api/meta.js` ใช้สมองเดียวกับ LINE (`lib/core.js`) Webhook URL: `https://<โดเมนของคุณ>.vercel.app/api/meta`

| Key | ที่มา |
|---|---|
| `META_APP_SECRET` | Meta app → App settings → Basic → App secret |
| `META_VERIFY_TOKEN` | ข้อความอะไรก็ได้ที่คุณตั้งเอง ใช้ตอนกรอก Webhook ในแอป Meta |
| `META_PAGE_ACCESS_TOKEN` | Messenger → API setup → Generate token (ของเพจ) |
| `META_APP_ID` | (แนะนำ) App ID ของแอป |

กติกา: บอทตอบเฉพาะบทสนทนาใหม่ ถ้าแอดมินพิมพ์ตอบเองในกล่องข้อความเพจ บอทจะเงียบกับลูกค้าคนนั้นถาวร
