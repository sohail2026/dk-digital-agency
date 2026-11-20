# DK Digital Agency — ফেসবুক সকল সার্ভিস ওয়ালেট অ্যাপ

Facebook services business-এর জন্য wallet + order অ্যাপ।
কাস্টমার নিজের মোবাইল নম্বর দিয়ে অ্যাকাউন্ট খুলবে, ওয়ালেটে টাকা যোগ করবে,
সার্ভিস অর্ডার করবে। অ্যাডমিন (Sohel) প্রতিটি অর্ডারে নিজে দাম বসাবেন —
কাস্টমার কনফার্ম করলে ওয়ালেট থেকে টাকা কাটবে।

## কী কী আছে (Features)

- কাস্টমার রেজিস্টার/লগইন — নাম + মোবাইল নম্বর + ৪ সংখ্যার PIN
  (PIN salt দিয়ে hash করে রাখা হয়, কোথাও plain PIN থাকে না)
- ১০টি সার্ভিস (বাংলা) — হোম পেজে দেখা যায়
- ওয়ালেট: bKash/Nagad-এ Send Money করে TrxID জমা → অ্যাডমিন অনুমোদন দিলে
  ব্যালেন্সে টাকা যোগ হয়। সম্পূর্ণ লেনদেনের হিসাব দেখা যায়।
- অর্ডার ফ্লো: অর্ডার → অ্যাডমিন দাম বসায় → কাস্টমার "কনফার্ম ও পে করুন"
  চাপে → ব্যালেন্স থেকে টাকা কাটে → কাজ চলছে → অ্যাডমিন সম্পন্ন করে
- অ্যাডমিন প্যানেল: ডিপোজিট অনুমোদন/বাতিল, অর্ডারে দাম বসানো,
  অর্ডার সম্পন্ন/বাতিল, সব কাস্টমারের ব্যালেন্স, পেমেন্ট নম্বর পরিবর্তন,
  অ্যাডমিন PIN পরিবর্তন
- প্রতিটি পেজে WhatsApp বাটন (01833990497)

## অ্যাডমিন লগইন (প্রথমবার)

- মোবাইল: **01833990497**
- PIN: **1234**
- ⚠️ লগইন করেই অ্যাডমিন প্যানেল → সেটিংস থেকে PIN পরিবর্তন করুন!

## চালানো (Run locally)

Node.js 22 বা তার বেশি লাগবে।

```bash
npm install
npm start
```

তারপর ব্রাউজারে খুলুন: http://localhost:3000

ডেটা থাকে `data/app.db` ফাইলে (SQLite)। প্রথমবার চালালে অ্যাডমিন অ্যাকাউন্ট
আপনা-আপনি তৈরি হয়।

## ডেপ্লয় (Deploy) — Render / Railway / VPS

অ্যাপটি `PORT` environment variable থেকে port নেয়, তাই যেকোনো host-এ চলে।

**Render.com (সহজ):**
1. এই ফোল্ডারটি GitHub-এ push করুন
2. Render-এ New → Web Service → repo বেছে নিন
3. Build Command: `npm install`, Start Command: `npm start`
4. Environment: `NODE_ENV=production`
5. ⚠️ Render-এর free instance-এ disk মুছে যায় (ephemeral) — আসল ব্যবহারের
   জন্য Render-এর **Persistent Disk** নিন, আর `DB_PATH` env var দিয়ে
   disk-এর পাথ দিন, যেমন `/data/app.db`

**Railway:**
1. GitHub repo connect করুন, Railway নিজে থেকে Node ধরে নেবে
2. Variables: `NODE_ENV=production`
3. আসল ব্যবহারের জন্য একটি Volume যোগ করে `DB_PATH` সেট করুন

**VPS (Ubuntu):**
```bash
sudo apt install nodejs npm
npm install
NODE_ENV=production PORT=3000 nohup npm start &
```
আরো ভালো: PM2 দিয়ে চালান (`npm i -g pm2`, `pm2 start server.js`),
আর nginx দিয়ে domain + HTTPS লাগান।

## Environment Variables

| Variable | কাজ | Default |
|---|---|---|
| `PORT` | কোন port-এ চলবে | `3000` |
| `DB_PATH` | SQLite ফাইলের পাথ | `data/app.db` |
| `NODE_ENV` | `production` হলে secure cookie | — |

## নিরাপত্তা নোট (Security notes)

- সব চেক সার্ভার-সাইডে: কাস্টমার শুধু নিজের ওয়ালেট/অর্ডার দেখতে পারে,
  দাম/ব্যালেন্স ক্লায়েন্ট থেকে আসা মান দিয়ে বদলানো যায় না।
- লগইনে ৫ বার ভুল PIN দিলে ১৫ মিনিট লক হয়।
- এখন কোনো SMS OTP নেই — কেউ অন্যের নম্বর দিয়ে অ্যাকাউন্ট খুলতে পারে।
  আসল ব্যবহারের আগে SMS gateway (যেমন SSL Wireless / BulkSMSBD) দিয়ে
  OTP যাচাই যোগ করা উচিত।
- bKash/Nagad পেমেন্ট এখন manual (Send Money + TrxID যাচাই)।
  অটোমেটিক পেমেন্টের জন্য bKash/Nagad merchant API লাগবে।
