# Block Platform

A tiny multiplayer 3D block game: one platform, move around, break and place blocks together.

## Run locally

    npm install
    npm start

Open http://localhost:3000 in two browser tabs to see multiplayer working.

## Playing with friends

1. Enter your name and click **Open world**. You get a 5-character world code.
2. Press Esc in-game to see the code (with Copy code / Copy invite link buttons).
3. Your friends enter their name, type the code under *join a friend's world*, and click **Join**.

Each world is separate. Worlds are deleted 5 minutes after the last player leaves.
Press Enter or T to chat.

> The server serves the game from the `public/` folder, so `index.html` must live at `public/index.html`.

## Deploy (GitHub + Render)

1. Create a new GitHub repo and push this folder to it:

       git init
       git add .
       git commit -m "Block Platform"
       git branch -M main
       git remote add origin https://github.com/YOUR_USER/block-platform.git
       git push -u origin main

2. On https://render.com: New + > Web Service > connect the repo.
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: Free
   (Or choose New + > Blueprint, which reads `render.yaml` automatically.)

3. When the deploy finishes, open your `.onrender.com` URL and share it.

## Notes

- World state is kept in server memory, so it resets when the server restarts/redeploys.
- Render's free tier sleeps after ~15 minutes without traffic; the first visit afterwards takes ~30-60 s to wake up.
- Desktop only (keyboard + mouse).
