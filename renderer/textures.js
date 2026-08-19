import * as THREE from 'three';

function cv(w = 512, h = 512) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return { c, g: c.getContext('2d') };
}
function finish(c, repX = 1, repY = 1) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repX, repY);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
function noise(g, w, h, amt, alpha) {
  const img = g.getImageData(0, 0, w, h), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * amt;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
    if (alpha !== undefined) d[i + 3] = alpha;
  }
  g.putImageData(img, 0, 0);
}

/* ---------- cardboard: kraft base + horizontal flutes + speckle ---------- */
export function cardboardTex(rep = 1, tone = '#c69a63') {
  const { c, g } = cv(512, 512);
  g.fillStyle = tone; g.fillRect(0, 0, 512, 512);
  for (let y = 0; y < 512; y += 7) {
    const a = 0.10 + 0.05 * Math.sin(y * 0.4);
    g.fillStyle = `rgba(96,62,30,${a})`;
    g.fillRect(0, y, 512, 3);
    g.fillStyle = 'rgba(255,225,190,0.07)';
    g.fillRect(0, y + 3, 512, 2);
  }
  for (let i = 0; i < 260; i++) {
    g.fillStyle = `rgba(${90 + Math.random() * 90},${60 + Math.random() * 60},${30 + Math.random() * 40},${0.10 + Math.random() * 0.2})`;
    g.beginPath();
    g.ellipse(Math.random() * 512, Math.random() * 512, 1 + Math.random() * 4, 1 + Math.random() * 2, Math.random() * 3, 0, 7);
    g.fill();
  }
  noise(g, 512, 512, 16);
  return finish(c, rep, rep);
}

/* ---------- corrugated edge (the cut flute profile) ---------- */
export function fluteEdgeTex(rep = 4) {
  const { c, g } = cv(128, 128);
  g.fillStyle = '#d8b183'; g.fillRect(0, 0, 128, 128);
  for (let x = 0; x < 128; x += 8) {
    g.fillStyle = 'rgba(120,80,42,0.55)';
    g.beginPath(); g.arc(x + 4, 64, 3.4, 0, 7); g.fill();
  }
  g.fillStyle = 'rgba(90,58,28,.35)'; g.fillRect(0, 0, 128, 6); g.fillRect(0, 122, 128, 6);
  return finish(c, rep, 1);
}

/* ---------- brushed / painted metal ---------- */
export function metalTex(rep = 2, tone = '#7d858f') {
  const { c, g } = cv(512, 512);
  g.fillStyle = tone; g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 1400; i++) {
    g.strokeStyle = `rgba(255,255,255,${Math.random() * 0.06})`;
    g.lineWidth = Math.random() * 1.6;
    const y = Math.random() * 512;
    g.beginPath(); g.moveTo(0, y); g.lineTo(512, y + (Math.random() - 0.5) * 4); g.stroke();
  }
  for (let i = 0; i < 40; i++) {           // rust freckles, cartoon amount
    g.fillStyle = `rgba(150,80,40,${0.05 + Math.random() * 0.12})`;
    g.beginPath(); g.arc(Math.random() * 512, Math.random() * 512, 3 + Math.random() * 14, 0, 7); g.fill();
  }
  noise(g, 512, 512, 12);
  return finish(c, rep, rep);
}

/* ---------- planed timber: grain, a couple of knots ---------- */
export function woodTex(rep = 1, tone = '#b07c47') {
  const { c, g } = cv(512, 512);
  g.fillStyle = tone; g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 130; i++) {
    const y = Math.random() * 512;
    const dark = Math.random() > 0.6;
    g.strokeStyle = dark ? `rgba(88,52,22,${0.10 + Math.random() * 0.22})` : `rgba(226,186,132,${0.05 + Math.random() * 0.14})`;
    g.lineWidth = 0.6 + Math.random() * 3.4;
    g.beginPath();
    g.moveTo(0, y);
    for (let x = 0; x <= 512; x += 32) g.lineTo(x, y + Math.sin(x * 0.02 + i) * 4 + (Math.random() - 0.5) * 2);
    g.stroke();
  }
  for (let k = 0; k < 3; k++) {                       // knots
    const kx = 60 + Math.random() * 392, ky = 60 + Math.random() * 392;
    for (let r = 26; r > 0; r -= 3) {
      g.strokeStyle = `rgba(84,50,22,${0.30 - r * 0.008})`;
      g.lineWidth = 2;
      g.beginPath(); g.ellipse(kx, ky, r, r * 0.62, 0.4, 0, 7); g.stroke();
    }
  }
  noise(g, 512, 512, 14);
  return finish(c, rep, rep);
}

/* ---------- polished concrete floor ---------- */
export function concreteTex(rep = 6, tone = '#3a3a3c') {
  const { c, g } = cv(512, 512);
  g.fillStyle = tone; g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 900; i++) {
    g.fillStyle = `rgba(${Math.random() * 255 | 0},${Math.random() * 255 | 0},${Math.random() * 255 | 0},0.035)`;
    g.beginPath(); g.arc(Math.random() * 512, Math.random() * 512, Math.random() * 6, 0, 7); g.fill();
  }
  g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = 3;
  g.strokeRect(0, 0, 512, 512);
  noise(g, 512, 512, 18);
  return finish(c, rep, rep);
}

/* ---------- server rack face ---------- */
export function rackTex(rep = 1) {
  const { c, g } = cv(256, 512);
  g.fillStyle = '#15181d'; g.fillRect(0, 0, 256, 512);
  for (let y = 8; y < 500; y += 22) {
    g.fillStyle = '#1e232a'; g.fillRect(10, y, 236, 18);
    g.fillStyle = '#0d1014';
    for (let x = 22; x < 200; x += 12) g.fillRect(x, y + 5, 7, 8);
    // status LEDs
    const on = Math.random() > 0.35;
    g.fillStyle = on ? (Math.random() > 0.2 ? '#4ade80' : '#fbbf24') : '#243040';
    g.fillRect(224, y + 6, 6, 6);
    g.fillStyle = Math.random() > 0.5 ? '#38bdf8' : '#1e293b';
    g.fillRect(214, y + 6, 5, 6);
  }
  return finish(c, rep, rep);
}

/* ---------- gallery wall ---------- */
export function galleryTex(rep = 3) {
  const { c, g } = cv(512, 512);
  const grd = g.createLinearGradient(0, 0, 0, 512);
  grd.addColorStop(0, '#efe9df'); grd.addColorStop(1, '#d9d1c4');
  g.fillStyle = grd; g.fillRect(0, 0, 512, 512);
  noise(g, 512, 512, 8);
  return finish(c, rep, rep);
}

/* ---------- marker-drawn sign on cardboard ---------- */
export function signTex(text, sub = '') {
  const { c, g } = cv(512, 256);
  g.fillStyle = '#c9a274'; g.fillRect(0, 0, 512, 256);
  for (let y = 0; y < 256; y += 6) {
    g.fillStyle = 'rgba(110,72,36,0.13)'; g.fillRect(0, y, 512, 2);
  }
  g.strokeStyle = '#2b1d10'; g.lineWidth = 7; g.lineCap = 'round';
  g.font = 'bold 84px "Comic Sans MS", "Chalkboard SE", cursive, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = '#241708';
  g.save(); g.translate(256, sub ? 96 : 128); g.rotate(-0.025);
  g.fillText(text, 0, 0);
  g.restore();
  if (sub) {
    g.font = '40px "Comic Sans MS", "Chalkboard SE", cursive, sans-serif';
    g.save(); g.translate(256, 178); g.rotate(0.02);
    g.fillText(sub, 0, 0); g.restore();
  }
  g.strokeStyle = 'rgba(40,26,12,.55)'; g.lineWidth = 5;
  g.strokeRect(8, 8, 496, 240);
  noise(g, 512, 256, 12);
  return finish(c, 1, 1);
}

/* ---------- one face of the CAD orientation cube ---------- */
export function cubeFaceTex(label) {
  const { c, g } = cv(128, 128);
  const grd = g.createLinearGradient(0, 0, 0, 128);
  grd.addColorStop(0, '#2c333d'); grd.addColorStop(1, '#222831');
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  g.strokeStyle = '#4a5766'; g.lineWidth = 4;
  g.strokeRect(2, 2, 124, 124);
  g.fillStyle = '#c9d4e0';
  g.font = '600 26px ui-monospace, Menlo, monospace';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(label, 64, 66);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ---------- Rivet's marker face ---------- */
export function faceTex(mood = 'happy') {
  const { c, g } = cv(256, 256);
  g.fillStyle = '#cda476'; g.fillRect(0, 0, 256, 256);
  for (let y = 0; y < 256; y += 6) { g.fillStyle = 'rgba(110,72,36,0.11)'; g.fillRect(0, y, 256, 2); }
  g.strokeStyle = '#231607'; g.fillStyle = '#231607';
  g.lineWidth = 9; g.lineCap = 'round'; g.lineJoin = 'round';
  // eyes
  g.beginPath(); g.arc(88, 104, 15, 0, 7); g.fill();
  g.beginPath(); g.arc(168, 104, 15, 0, 7); g.fill();
  // brows
  g.beginPath();
  if (mood === 'focus') { g.moveTo(66, 72); g.lineTo(108, 84); g.moveTo(190, 72); g.lineTo(148, 84); }
  else { g.moveTo(66, 76); g.lineTo(108, 68); g.moveTo(190, 76); g.lineTo(148, 68); }
  g.stroke();
  // mouth
  g.beginPath();
  if (mood === 'focus') g.moveTo(96, 172), g.lineTo(160, 172);
  else g.arc(128, 152, 42, 0.25 * Math.PI, 0.75 * Math.PI);
  g.stroke();
  noise(g, 256, 256, 10);
  return finish(c, 1, 1);
}

/* A hi-vis name plate for a robot's chest. Five of them look identical from
   across the shop otherwise, and "which one is welding" is the single most
   asked question about a floor with a crew on it. */
export function nameTex(name, trade = '') {
  const { c, g } = cv(512, 256);
  g.fillStyle = '#f0e6d2'; g.fillRect(0, 0, 512, 256);
  for (let y = 0; y < 256; y += 7) { g.fillStyle = 'rgba(120,90,50,0.08)'; g.fillRect(0, y, 512, 2); }
  g.fillStyle = '#1b1410';
  g.font = 'bold 108px "Helvetica Neue", Arial, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(String(name).toUpperCase().slice(0, 9), 256, 104);
  if (trade) {
    g.fillStyle = '#6a5340';
    g.font = '44px "Helvetica Neue", Arial, sans-serif';
    g.fillText(String(trade).toUpperCase().slice(0, 22), 256, 186);
  }
  g.strokeStyle = '#1b1410'; g.lineWidth = 10; g.strokeRect(5, 5, 502, 246);
  noise(g, 512, 256, 8);
  return finish(c, 1, 1);
}
