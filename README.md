# ⚡ TikTok Like Battle Arena

เกม Auto-Battler 2D ฉายบนจอไลฟ์ TikTok — ผู้ชมเล่นผ่านการ**กดไลค์**และ**ส่งของขวัญ**เท่านั้น
ตัวละครเกิดเอง เดินเอง สู้กันเอง สุ่มกาชาปองเอง พร้อม MC บรรยายเสียงไทย/อังกฤษ/ญี่ปุ่น (Microsoft Edge TTS)

ฟรี 100% — Render Free + Supabase Free + Edge TTS + PixiJS

---

## 🚀 วิธี Deploy บน Render (ครั้งเดียวจบ)

1. push โฟลเดอร์นี้ขึ้น GitHub repo ของคุณ
2. เข้า [render.com](https://render.com) → **New → Blueprint** → เลือก repo นี้ (มี `render.yaml` ให้แล้ว)
   หรือ **New → Web Service** → Build: `npm install` → Start: `node server/index.js` → Plan: **Free**
3. ตั้ง Environment Variables (ดูด้านล่าง) → Deploy

## 🔑 Environment Variables

| ตัวแปร | จำเป็น | คำอธิบาย |
|---|---|---|
| `TOTP_SECRET` | แนะนำมาก | รหัส base32 สำหรับล็อกหน้า /settings — สร้างใหม่ได้ที่เว็บ TOTP generator หรือคำสั่ง node ด้านล่าง ถ้าไม่ตั้งจะใช้ค่า default (ไม่ปลอดภัย) |
| `SUPABASE_URL` | แนะนำ | จากโปรเจกต์ Supabase (Settings → API) — ใช้เก็บ config + ไฟล์อัปโหลดแบบถาวร |
| `SUPABASE_SERVICE_KEY` | แนะนำ | service_role key จากหน้าเดียวกัน |

ไม่ตั้ง Supabase ก็เล่นได้ แต่ค่า config และไฟล์ที่อัปโหลดจะ**หายเมื่อ server restart**

**สร้าง TOTP secret ใหม่:**
```bash
node -e "console.log(require('otplib').authenticator.generateSecret())"
```
เอา secret ไปกรอกในแอป Authenticator (เพิ่มบัญชีแบบ manual / enter setup key)

## 🗄️ ตั้งค่า Supabase (ครั้งเดียว)

1. สร้างโปรเจกต์ฟรีที่ [supabase.com](https://supabase.com)
2. ไปที่ SQL Editor รันคำสั่ง:
```sql
create table if not exists app_settings (id int primary key, data jsonb);
```
3. Storage bucket `battle-assets` ระบบจะสร้างให้เองตอนอัปโหลดครั้งแรก
4. คัดลอก URL + service_role key ไปใส่ env ของ Render

## 📱 วิธีไลฟ์จาก iPhone แบบเต็มจอ (ไม่มี address bar)

1. เปิด `https://<แอปของคุณ>.onrender.com/arena` ใน Safari
2. ปุ่มแชร์ → **เพิ่มไปยังหน้าจอโฮม**
3. เปิดจาก**ไอคอนบนหน้าโฮม**เท่านั้น → เต็มจอ 100%
4. แตะปุ่ม **"เริ่มถ่ายทอด!"** (ปลดล็อกเสียง MC + กันจอดับ)
5. เปิดแอป TikTok → เริ่มไลฟ์แบบ**แชร์หน้าจอ** → สลับกลับมาที่แอปเกม
6. เปิดโหมดห้ามรบกวนกันแจ้งเตือนเด้ง

## 🎛️ ลำดับการใช้งานแต่ละครั้ง

1. เปิด `/host` (เครื่องไหนก็ได้) **ก่อนไลฟ์ 1-2 นาที** — ปลุก server จากโหมดหลับของ Render Free
2. เริ่มไลฟ์บน TikTok ก่อน แล้วค่อยกรอก username → **เชื่อมต่อ**
3. กด **เริ่มเกม**
4. บนหน้า `/host` มี**โหมดทดสอบ** จำลองไลค์/ของขวัญได้โดยไม่ต้องไลฟ์จริง

## 🎮 กติกา (ค่า default — แก้ได้ใน /settings)

- ไลค์ครบ 50 → เกิดตัวละคร | ไลค์ทุก 50 → กาชา Common | ไลค์ 1 ครั้ง = +1 MP
- ของขวัญ: 1–99💎 = Rare, 100–999💎 = Epic, 1,000+💎 = Legendary
- ไม่กดไลค์เกิน 60 วิ = ตัวละครตาย | HP หมด = ตกรอบ | เหลือคนสุดท้าย = ชนะ
- ตัวละครเดินสุ่ม โจมตีสุ่ม ใช้ไอเทมอัตโนมัติ

## ⚙️ /settings (ล็อกด้วย Authenticator)

ตั้งค่ากติกาทุกตัวเลข, อัปโหลดฉากหลัง, sprite ตัวละคร 20 ช่อง (PNG พื้นใส), BGM และเสียงเอฟเฟกต์ทุกแบบ
ช่อง sprite ที่ว่าง = ใช้ตัวละคร default ที่วาดในตัวเกม (20 แบบ ไม่ซ้ำกัน)

## ⚠️ ข้อจำกัด

- `tiktok-live-connector` เป็น library ไม่ทางการ — TikTok อัปเดตระบบอาจใช้ไม่ได้ชั่วคราว
- Render Free หลับหลังว่าง 15 นาที (ตื่น ~50 วิ) — เปิด /host ปลุกก่อนไลฟ์เสมอ
- Edge TTS เป็นบริการไม่ทางการของ Microsoft — ถ้าล่ม MC จะ fallback ไปเสียง TTS ของเครื่องอัตโนมัติ
- ไลค์จาก TikTok มาเป็นก้อน (กดรัวรวมเป็น event เดียว) — แต้มครบ ไม่หาย
