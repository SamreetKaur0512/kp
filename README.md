# Karan Patel Role-Play (fan-made)

Real multiplayer app: own register/login, lobby, public Game IDs, join requests, AI role-play,
AI scoring, leaderboard. Everything runs on the server, so friends only need the link.

## Run locally
1. Copy `.env.example` to `.env`, set `MONGODB_URI` and the three Cloudinary values. Set `GEMINI_API_KEY` (or set `AI_PROVIDER=claude` and `ANTHROPIC_API_KEY`). Set a private `ADMIN_PASSWORD` if you want moderator tools.
2. Run `npm install`.
3. Run `node --env-file=.env server.js` and open http://localhost:3000. (Node 20.6+.)
(Without a key a FAKE AI is used, for testing only.)

## Fan chat and moderation
- Sign in or register to post in the public fan room. Text, links, up to five images/videos per message are supported; there is no app-level video duration or file-size cap.
- Instagram/Reels links open on Instagram. Instagram controls whether a Reel can be embedded elsewhere.
- Set `ADMIN_PASSWORD` on the server. The Moderator button appears once it is configured; sign in there to delete messages, search registered members, block or unblock fan-chat access, and review the blocked-users list.
- Chat posts and Cloudinary media references are saved in MongoDB. Uploaded photos and videos are stored in Cloudinary, so Render does not need a persistent disk for chat uploads.
- Members can delete their own posts. Deleted posts remain as anonymous removal notices, and attached Cloudinary media is deleted where possible. Selected photos and videos show local previews before posting.
- Every signed-in member can see the latest public fan-chat history, including posts made before they registered. New registrations add a colorful public welcome notice. Reactions, threaded replies, and deleted reply notices are stored with the existing MongoDB chat documents.
- Cloudinary and its account plan enforce upload size, format, and storage limits.
- Role-play results prioritize how convincingly each player portrayed their selected character, including in-character dialogue, reactions to the scene, and staying in role. The complete transcript is context, but only that player's lines are scored; message quantity alone does not determine the acting score.
- Choose **Karan Patel Quiz** to host a multiple-choice game with 5, 10, 15, 20, 25, or 30 questions. Share the Game ID to join directly without host approval, or use **Request to join** in the open games list to ask the host. Each quiz question advances shortly after everyone answers, or after 30 seconds if someone has not answered. Serial role-play continues to use a duration and asks each player for their character rather than their account name.
- The community top three use each account's average score across all saved quiz and role-play games, including solo games.
- Members choose whether to receive notifications at registration and can change that choice in Settings. They receive private alerts when their messages or replies get a reply or reaction. The inbox expires notices after 24 hours. For phone/browser notifications while the site is closed, configure `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` in the server environment; browser push also requires a supported browser and permission from the member. Host notices are removed from the in-app inbox when the game starts.
- Members can change their account name in Settings; chat history and the public average-score leaderboard show the current name.
- Generate a VAPID key pair with `npx web-push generate-vapid-keys`, set the public and private values in the server environment, and set `VAPID_SUBJECT` to a contact such as `mailto:admin@example.com`. Serve the app over HTTPS for browser push.
- The login screen and fan room prominently warn that AI role-play and quiz answers can be inaccurate; verify important facts.

## Role-play safety and references
- Role-play is text-only; its server rejects image/video attachments.
- The role-play prompt no longer sends curated link-derived career, show, family, or relationship notes to the model. It relies on the model's general knowledge, asks it to distinguish on-screen fiction from real-life claims, and to state uncertainty rather than inventing facts.
- The AI can portray multiple non-player characters in one turn when the scene calls for it, while leaving every player-selected character under that player's control. It prioritizes the latest player line and responds to its addressee. It distinguishes absent/past mentions from direct summons and affirmative arrivals, bringing a character into the scene only when context supports it.
- If asked for private or safety-sensitive details, the AI must not reveal or confirm them, but should explain the privacy or safety reason plainly. It may step out of character; it does not have to hide the boundary or force a topic change. This includes private contact/location/schedule/security information and a child's school or other identifying details.
- Source checks used the public [Karan Patel](https://en.wikipedia.org/wiki/Karan_Patel), [Kahaani Ghar Ghar Kii](https://en.wikipedia.org/wiki/Kahaani_Ghar_Ghar_Kii), [Kasamh Se](https://en.wikipedia.org/wiki/Kasamh_Se), [Kkavyanjali](https://en.wikipedia.org/wiki/Kkavyanjali), [Kasturi (2007)](https://en.wikipedia.org/wiki/Kasturi_(2007_TV_series)), [Yeh Hai Mohabbatein](https://en.wikipedia.org/wiki/Yeh_Hai_Mohabbatein), [Kasautii Zindagii Kay (2018)](https://en.wikipedia.org/wiki/Kasautii_Zindagii_Kay_(2018_TV_series)), [Shootout at Wadala](https://en.wikipedia.org/wiki/Shootout_at_Wadala), [City of Gold](https://en.wikipedia.org/wiki/City_of_Gold_(2010_film)), [Phamous](https://en.wikipedia.org/wiki/Phamous), [Raktanchal](https://en.wikipedia.org/wiki/Raktanchal), [Jhalak Dikhhla Jaa 6](https://en.wikipedia.org/wiki/Jhalak_Dikhhla_Jaa_season_6), [Khatron Ke Khiladi 10](https://en.wikipedia.org/wiki/Fear_Factor:_Khatron_Ke_Khiladi_10), [Survivor India](https://en.wikipedia.org/wiki/Survivor_India_(season_1)), and [Nach Baliye](https://en.wikipedia.org/wiki/Nach_Baliye) pages, plus the linked IndiaForums, Bollywood Hungama, Apple TV, Prime Video, and Knowlepedia listings. Off-screen facts are limited to public reporting, including [Anita Hassanandani's interview](https://www.indiaforums.com/article/karan-patel-and-anita-hassanandani-reunite-after-a-decade-anita-says-getting-paired-with-karan_235904), the [2019 daughter-name report](https://www.indiaforums.com/article/karan-patel-ankita-bhargava-reveal-their-daughters-name_158162), and [Business Standard's PTI interview about Ekta Kapoor](https://www.business-standard.com/article/pti-stories/i-share-a-comfort-level-with-ekta-kapoor-113120201279_1.html).
- The supplied Karam Apnaa Appnaa and Box Cricket League Wikipedia links did not resolve. The linked Raktanchal cast does not list Patel, and Prime Video's Reva detail lists a different credited cast; these are explicitly marked as unverified/mismatched rather than treated as acting credits. This is a summarized public reference set, not a word-for-word copy of those pages or an exhaustive database of every title.

## Put online (Render.com, simplest)
1. Upload this folder to a GitHub repo.
2. Render -> New -> Web Service -> pick the repo. Build: `npm install`  Start: `npm start`
3. Environment: add MONGODB_URI, CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET, AI_PROVIDER=gemini, GEMINI_API_KEY, and a private ADMIN_PASSWORD. Get the Cloudinary values from your Cloudinary dashboard. For Claude instead, use AI_PROVIDER=claude and ANTHROPIC_API_KEY. No Render disk is required for chat uploads.
4. Share the Render URL. Put your own logo as `public/logo.png` (clicking it opens Register).

## Notes
- Live games are kept in server memory; a server restart ends running games (accounts and wins are saved).
- You pay for the AI usage on your API key. Limits built in: 1 line/second, 500 chars/line, max 30 min games.
- Use only a photo you own or are licensed to use for logo.png.

## Photo that opens the app
- Your link (`https://your-app.onrender.com`) already shows your `logo.png` as a photo card when shared on WhatsApp, Telegram, Facebook, X, etc. People tap the card and the app opens.
- `https://your-app.onrender.com/p` is a poster page: one big photo, tapping it opens the app. Use it as the link in your Instagram bio, Linktree, or website.
- On a website you own, use: `<a href="https://your-app.onrender.com"><img src="logo.png"></a>`
- Plain image posts on Instagram/WhatsApp cannot hold a link themselves; put the link in the caption/bio.

## Free AI option (Google Gemini)
Get a key at aistudio.google.com/app/apikey, then set on the server:
    AI_PROVIDER=gemini
    GEMINI_API_KEY=your-key
    GEMINI_MODEL=gemini-3.5-flash-lite      (default; about 15 requests/min, 500 per day on the free tier)
The server spaces AI calls (AI_RPM, default 12/min) and uses 1 judge (JUDGES=1) to stay inside the free limit.
Free tier = only about 1-2 games at the same time. Check your limits in AI Studio -> Rate Limit.
To use Claude instead: AI_PROVIDER=claude and ANTHROPIC_API_KEY=...
