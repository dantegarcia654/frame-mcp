// Scripted pass over a finished project, to film the parts of Frame a person drives by hand.
export default async function ({ evaluate, mouse, sleep, send, mark }) {
  const rect = (sel, nth = 0) => evaluate(`(() => { const e = document.querySelectorAll(${JSON.stringify(sel)})[${nth}]; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  const mid = (r) => [r.x + r.w / 2, r.y + r.h / 2];
  await mouse.move(820, 300, 300);
  // 1 · play the live preview
  await evaluate('__frame.seek(3.2)'); await sleep(1500);
  mark('play'); await mouse.click(...mid(await rect('#play')), 600); await sleep(9000);
  await evaluate('if (document.querySelector("#play").textContent !== "▶") __frame.togglePlay()'); mark('play_end'); await sleep(500);
  // 2 · hand edit: drag a shot's edge to trim it, then slide a caption
  const shot = await rect('.lane[data-track="V1"] .clip', 8);
  mark('trim'); await mouse.move(shot.x + shot.w - 3, shot.y + shot.h / 2, 900); await sleep(300);
  await mouse.press(); await mouse.move(shot.x + shot.w - 46, shot.y + shot.h / 2, 1100); await sleep(350); await mouse.release(); await sleep(1500);
  const cap = await rect('.lane[data-track="T1"] .clip', 12);
  await mouse.move(cap.x + cap.w / 2, cap.y + cap.h / 2, 700); await mouse.press(); await mouse.move(cap.x + cap.w / 2 + 30, cap.y + cap.h / 2, 800); await sleep(250); await mouse.release(); await sleep(1500); mark('trim_end');
  // 3 · steer: type a message to Claude
  const box = await rect('#composer textarea');
  mark('msg'); await mouse.click(...mid(box), 800); await sleep(300);
  for (const ch of 'Swap the agent swarm card to come before submit') { await send('Input.insertText', { text: ch }); await sleep(34); }
  await sleep(500); await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(2400); await evaluate('document.activeElement.blur()'); mark('msg_end');
  // 4 · pause button
  const pz = await rect('#pause');
  mark('pause'); await mouse.click(...mid(pz), 800); await sleep(2400); await mouse.click(...mid(pz), 300); await sleep(900); mark('pause_end');
  // 5 · open the process step and read the code
  mark('code'); await mouse.click(...mid(await rect('#steps .step')), 900); await sleep(4600);
  await mouse.click(...mid(await rect('#closeModal')), 600); await sleep(700); mark('code_end');
}
