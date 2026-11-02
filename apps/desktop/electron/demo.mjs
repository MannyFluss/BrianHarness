// Scripted demo used only for EEG_SCREENSHOT runs: types replies into the real composer
// via the renderer's test hook so telemetry flows through the normal path.
const replies = [
  "Honestly lately it's mostly making little indie games, I've been prototyping a roguelike in my own engine",
  "Ooh, the boss design for sure. I love when a level teaches you the mechanic before the boss tests it. What about you?",
];
export async function runDemo(win) {
  const wc = win.webContents;
  await wc.executeJavaScript("new Promise(r => { const t = setInterval(() => { if (window.__eegDemo) { clearInterval(t); r(); } }, 100); })");
  for (const text of replies) {
    await wc.executeJavaScript(`window.__eegDemo.type(${JSON.stringify(text)})`);
    await new Promise((r) => setTimeout(r, 600));
  }
  await wc.executeJavaScript(`window.__eegDemo.draft("I think it's the moment it clicks")`);
}
