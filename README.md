# DK Digital Agency — ফেসবুক সকল সার্ভিস ওয়ালেট অ্যাপ (v2)

Facebook services business-এর জন্য wallet + order অ্যাপ।
কাস্টমার নিজের মোবাইল নম্বর বা ইমেইল দিয়ে অ্যাকাউন্ট খুলবে, ওয়ালেটে টাকা
যোগ করবে, সার্ভিস অর্ডার করবে। অ্যাডমিন (Sohel) প্রতিটি অর্ডারে নিজে দাম
বসাবেন — কাস্টমার কনফার্ম করলে ওয়ালেট থেকে টাকা কাটবে।

⚠️ **v2-তে ডেটাবেস বদলে গেছে:** আগে SQLite ফাইলে ডেটা থাকত — Render-এর free
disk restart-এ মুছে যায় বলে এক রাতে সব কাস্টমার ডেটা হারিয়ে গিয়েছিল।
এখন ডেটা থাকে **PostgreSQL (Neon free tier)**-এ, যা Render restart হলেও
মুছে যায় না। অ্যাপ চালাতে `DATABASE_URL` লাগবেই (নিচে দেখুন)।

## কী কী আছে (Features)

- কাস্টমার রেজিস্টার/লগইন — নাম + **মোবাইল নম্বর বা ইমেইল** + ৪ সংখ্যার PIN
  (PIN salt দিয়ে hash করে রাখা হয়, কোথাও plain PIN থাকে না)
- ১০টি সার্ভিস (বাংলা) — হোম পেজে দেখা যায়
- ওয়ালেট: bKash/Nagad-এ Send Money করে TrxID জমা → অ্যাডমিন অনুমোদন দিলে
  ব্যালেন্সে টাকা যোগ হয়। সম্পূর্ণ লেনদেনের হিসাব দেখা যায়।
- অর্ডার ফ্লো: অর্ডার → অ্যাডমিন দাম বসায় → কাস্টমার "কনফর্ম ও পে করুন"
  চাপে → ব্যালেন্স থেকে টাকা কাটে → কাজ চলছে → অ্যাডমিন সম্পন্ন করে
- **মেসেজ:** কাস্টমার অ্যাপের ভেতর থেকেই অ্যাডমিনকে মেসেজ পাঠাতে পারে,
  অ্যাডমিন উত্তর দিতে পারে (অ্যাডমিন প্যানেল → মেসেজ ট্যাব)
- অ্যাডমিন প্যানেল: ডিপোজিট অনুমোদন/বাতিল, অর্ডারে দাম বসানো,
  অর্ডার সম্পন্ন/বাতিল, সব কাস্টমারের ব্যালেন্স, **ব্যালেন্স হাতে ঠিক করা**
  (যোগ/বিয়োগ + কারণসহ নোট — হারানো টাকা ফেরত দিতে), পেমেন্ট নম্বর পরিবর্তন,
  অ্যাডমিন PIN পরিবর্তন, কাস্টমার মেসেজের উত্তর
- প্রতিটি পেজে WhatsApp বাটন (01833990497)

## অ্যাডমিন লগইন (প্রথমবার)

- মোবাইল: **01833990497**
- PIN: **1234**
- ⚠️ লগইন করেই অ্যাডমিন প্যানেল → সেটিংস থেকে PIN পরিবর্তন করুন!

## Neon free database setup (ডেটাবেস তৈরি করা)

ডেটা নিরাপদ রাখতে Neon-এর ফ্রি PostgreSQL ব্যবহার করা হয়। একবার সেটআপ
করলেই হবে:

1. [neon.tech](https://neon.tech) খুলে **Sign Up** করুন (Google/GitHub
   দিয়ে ফ্রি অ্যাকাউন্ট খোলা যায় — কার্ড লাগে না)।
2. **Create Project** চাপুন — নাম দিন `dk-digital-agency`, region বেছে নিন
   **Singapore** (বাংলাদেশের সবচেয়ে কাছে)।
3. প্রজেক্ট তৈরি হলে **Connection String** দেখাবে — দেখতে এরকম:
   `postgresql://<user>:<password>@<host>/neondb?sslmode=require`
   **Copy** চেপে পুরো লাইনটি কপি করুন (পাসওয়ার্ডসহ)।
4. **Render-এ:** ড্যাশবোর্ডে সার্ভিস খুলে **Environment** → **Add Environment
   Variable** → Key: `DATABASE_URL`, Value: কপি করা connection string →
   **Save Changes**। Render নিজে থেকে redeploy করবে।
5. **কম্পিউটারে চালাতে:** `DATABASE_URL` environment variable সেট করে
   `npm start` চালান (নিচে দেখুন)।

⚠️ `DATABASE_URL` ছাড়া অ্যাপ চালু হবে না — এটা ইচ্ছা করেই করা, যাতে ডেটা
কখনো ভুল করে অস্থায়ী ফাইলে না যায়। Connection string কাউকে দেবেন না —
এতে ডেটাবেসের পুরো অ্যাক্সেস থাকে।

## চালানো (Run locally)

Node.js 22 বা তার বেশি লাগবে।

```bash
npm install
```

তারপর `DATABASE_URL` সেট করে চালান:

**Windows (PowerShell):**
```powershell
$env:DATABASE_URL="postgresql://<user>:<password>@<host>/neondb?sslmode=require"
npm start
```

**Mac / Linux:**
```bash
DATABASE_URL="postgresql://<user>:<password>@<host>/neondb?sslmode=require" npm start
```

তারপর ব্রাউজারে খুলুন: http://localhost:3000

প্রথমবার চালালে টেবিলগুলো আপনা-আপনি তৈরি হয় আর অ্যাডমিন অ্যাকাউন্ট
তৈরি হয়।

## ডেপ্লয় (Deploy) — Render / Railway / VPS

অ্যাপটি `PORT` environment variable থেকে port নেয়, তাই যেকোনো host-এ চলে।
ডেটাবেস Neon-এ থাকে, তাই host-এর disk মুছে গেলেও ডেটা নিরাপদ।

**Render.com (সহজ):**
1. এই ফোল্ডারটি GitHub-এ push করুন
2. Render-এ New → Web Service → repo বেছে নিন
3. Build Command: `npm install`, Start Command: `npm start`
4. Environment: `NODE_ENV=production` এবং `DATABASE_URL` (Neon connection string — উপরে দেখুন)

**Railway:**
1. GitHub repo connect করুন, Railway নিজে থেকে Node ধরে নেবে
2. Variables: `NODE_ENV=production`, `DATABASE_URL` (Neon connection string)

**VPS (Ubuntu):**
```bash
sudo apt install nodejs npm
npm install
NODE_ENV=production PORT=3000 DATABASE_URL="postgresql://..." nohup npm start &
```
আরো ভালো: PM2 দিয়ে চালান (`npm i -g pm2`, `pm2 start server.js`),
আর nginx দিয়ে domain + HTTPS লাগান।

## Environment Variables

| Variable | কাজ | Default |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string (Neon) — **আবশ্যক** | — |
| `PORT` | কোন port-এ চলবে | `3000` |
| `NODE_ENV` | `production` হলে secure cookie | — |

## নিরাপত্তা নোট (Security notes)

- সব চেক সার্ভার-সাইডে: কাস্টমার শুধু নিজের ওয়ালেট/অর্ডার/মেসেজ দেখতে পারে,
  দাম/ব্যালেন্স ক্লায়েন্ট থেকে আসা মান দিয়ে বদলানো যায় না।
- লগইনে ৫ বার ভুল PIN দিলে ১৫ মিনিট লক হয়।
- এখন কোনো SMS/email OTP নেই — কেউ অন্যের নম্বর বা ইমেইল দিয়ে অ্যাকাউন্ট
  খুলতে পারে। আসল ব্যবহারের আগে OTP যাচাই যোগ করা উচিত।
- bKash/Nagad পেমেন্ট এখন manual (Send Money + TrxID যাচাই)।
  অটোমেটিক পেমেন্টের জন্য bKash/Nagad merchant API লাগবে।
- `DATABASE_URL` গোপন রাখুন — এতে ডেটাবেসের পুরো অ্যাক্সেস থাকে।
