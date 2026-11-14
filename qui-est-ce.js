// ============================================================
//  qui-est-ce.js — module serveur du jeu « Qui est-ce ? »
//  Branchement dans server.js (2 lignes) :
//    const quiEstCe = require('./qui-est-ce');      // en haut
//    quiEstCe.attach(ws);                            // dans wss.on('connection', (ws) => { ... })
//  Tous les messages de ce jeu commencent par "qec_" : les autres jeux ne sont pas touchés.
// ============================================================

const NB_PERSOS = 24; // personnages par plateau
let POOL = 228;       // taille du stock de photos
try { POOL = require('./public/qui-est-ce/photos.js').length; } catch (e) { console.warn('[qui-est-ce] photos.js introuvable, stock =', POOL); }
const rooms = new Map();

// Tire 24 photos du stock en évitant celles déjà jouées dans cette partie
function makeBoard(room, avoid = []) {
  let free = [];
  for (let i = 0; i < POOL; i++) if (!room.used.has(i) && !avoid.includes(i)) free.push(i);
  if (free.length < NB_PERSOS) { room.used.clear(); free = []; for (let i = 0; i < POOL; i++) if (!avoid.includes(i)) free.push(i); }
  return shuffle(free).slice(0, NB_PERSOS);
}

function makeCode() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = Array.from({ length: 4 }, () => L[Math.floor(Math.random() * L.length)]).join(''); }
  while (rooms.has(c));
  return c;
}
const rid = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
const send = (ws, obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const randPerso = (...exclude) => { let x; do { x = Math.floor(Math.random() * NB_PERSOS); } while (exclude.includes(x)); return x; };
const validId = (x) => Number.isInteger(x) && x >= 0 && x < NB_PERSOS;

// Personnage que le joueur doit deviner
function targetOf(room, p) {
  if (room.mode === 'classe') return room.secret;
  if (p.opp === 'prof') return room.profSecret;
  const o = room.players.get(p.opp);
  return o ? o.secret : null;
}

function attach(ws) {
  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!data || typeof data.type !== 'string' || !data.type.startsWith('qec_')) return;
    try { handle(ws, data); } catch (e) { console.error('[qui-est-ce]', e); }
  });
  ws.on('close', () => {
    const info = ws._qec; if (!info) return;
    const room = rooms.get(info.code); if (!room) return;
    if (info.role === 'prof') { if (room.profWs === ws) room.profWs = null; }
    else { const p = room.players.get(info.id); if (p && p.ws === ws) { p.ws = null; p.connected = false; } }
    broadcast(room);
  });
}

function handle(ws, d) {
  // ---------- PROF ----------
  if (d.type === 'qec_create') {
    const code = makeCode();
    const room = {
      code, profKey: rid(), profWs: ws, mode: d.mode === 'classe' ? 'classe' : 'duel',
      players: new Map(), round: 0, active: false, revealed: false,
      secret: null, profSecret: null, winners: 0, last: Date.now(),
      used: new Set(), board: [], nextBoard: [],
    };
    room.nextBoard = makeBoard(room);
    rooms.set(code, room);
    ws._qec = { code, role: 'prof' };
    send(ws, { type: 'qec_created', code, key: room.profKey });
    return broadcast(room);
  }
  if (d.type === 'qec_profRejoin') {
    const room = rooms.get(String(d.code || '').toUpperCase());
    if (!room || room.profKey !== d.key) return send(ws, { type: 'qec_reset', msg: 'Cette partie n\'existe plus.' });
    room.profWs = ws; ws._qec = { code: room.code, role: 'prof' };
    return broadcast(room);
  }

  // ---------- ÉLÈVE : rejoindre ----------
  if (d.type === 'qec_join') {
    const code = String(d.code || '').trim().toUpperCase();
    const name = String(d.name || '').trim().slice(0, 20);
    const room = rooms.get(code);
    if (!room) return send(ws, { type: 'qec_error', msg: 'Code de partie introuvable.', reset: true });
    if (!name) return send(ws, { type: 'qec_error', msg: 'Écris ton prénom.' });
    let p = [...room.players.values()].find((x) => x.key && x.key === d.key);
    if (!p) {
      const taken = [...room.players.values()].find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (taken && taken.connected) return send(ws, { type: 'qec_error', msg: 'Ce prénom est déjà pris dans cette partie.' });
      if (taken) p = taken; // reconnexion sans clé : on reprend la place
    }
    if (!p) {
      p = { id: rid(), key: rid(), name, score: 0, status: 'attente', secret: null, opp: null, eliminated: [], guess: null, rank: 0 };
      if (room.active && room.mode === 'classe' && !room.revealed) p.status = 'joue';
      room.players.set(p.id, p);
    }
    if (p.ws && p.ws !== ws) { try { p.ws._qec = null; p.ws.close(); } catch (e) {} }
    p.ws = ws; p.connected = true;
    ws._qec = { code, role: 'eleve', id: p.id };
    send(ws, { type: 'qec_joined', code, key: p.key, name: p.name });
    return broadcast(room);
  }

  // ---------- messages qui demandent une partie ----------
  const info = ws._qec; if (!info) return;
  const room = rooms.get(info.code); if (!room) return;
  room.last = Date.now();
  const isProf = info.role === 'prof' && room.profWs === ws;

  if (isProf) {
    if (d.type === 'qec_mode' && !room.active) { room.mode = d.mode === 'classe' ? 'classe' : 'duel'; return broadcast(room); }
    if (d.type === 'qec_kick') { const p = room.players.get(d.id); if (p) { send(p.ws, { type: 'qec_reset', msg: 'Le prof t\'a retiré de la partie.' }); room.players.delete(d.id); fixPairsAfterLeave(room, d.id); } return broadcast(room); }
    if (d.type === 'qec_start') return startRound(room, d.secret);
    if (d.type === 'qec_shuffle' && !room.active) { room.nextBoard = makeBoard(room, room.nextBoard); return broadcast(room); }
    if (d.type === 'qec_reveal') {
      room.revealed = true;
      for (const p of room.players.values()) if (p.status === 'joue') p.status = 'fini';
      return broadcast(room);
    }
    if (d.type === 'qec_stop') { room.active = false; room.revealed = false; for (const p of room.players.values()) { p.status = 'attente'; } return broadcast(room); }
    if (d.type === 'qec_resetScores') { for (const p of room.players.values()) p.score = 0; return broadcast(room); }
    return;
  }

  const p = room.players.get(info.id); if (!p) return;

  if (d.type === 'qec_flip') {
    if (!Array.isArray(d.eliminated)) return;
    p.eliminated = [...new Set(d.eliminated.filter(validId))];
    return broadcast(room);
  }
  if (d.type === 'qec_guess') {
    if (!room.active || p.status !== 'joue' || !validId(d.id)) return;
    const target = targetOf(room, p);
    p.guess = d.id;
    const ok = d.id === target;
    if (room.mode === 'classe') {
      if (ok) { p.status = 'gagne'; p.rank = ++room.winners; p.score++; }
      else p.status = 'perdu';
      if (![...room.players.values()].some((x) => x.status === 'joue')) room.revealed = true;
    } else {
      const o = room.players.get(p.opp);
      if (ok) { p.status = 'gagne'; p.score++; if (o && o.status === 'joue') { o.status = 'perdu'; o.why = 'trouve'; } }
      else { p.status = 'perdu'; p.why = 'erreur'; if (o && o.status === 'joue') { o.status = 'gagne'; o.score++; o.why = 'adverse'; } }
    }
    return broadcast(room);
  }
}

function startRound(room, chosen) {
  room.round++; room.active = true; room.revealed = false; room.winners = 0; room.profSecret = null;
  room.board = room.nextBoard.length === NB_PERSOS ? room.nextBoard : makeBoard(room);
  room.board.forEach((i) => room.used.add(i));
  room.nextBoard = makeBoard(room);
  const list = [...room.players.values()];
  for (const p of list) { p.eliminated = []; p.guess = null; p.rank = 0; p.why = null; p.secret = null; p.opp = null; p.status = 'attente'; }
  if (room.mode === 'classe') {
    room.secret = validId(chosen) ? chosen : randPerso();
    for (const p of list) p.status = 'joue';
  } else {
    room.secret = null;
    const present = shuffle(list.filter((p) => p.connected));
    for (let i = 0; i + 1 < present.length; i += 2) {
      const a = present[i], b = present[i + 1];
      a.secret = randPerso(); b.secret = randPerso(a.secret);
      a.opp = b.id; b.opp = a.id; a.status = b.status = 'joue';
    }
    if (present.length % 2 === 1) { // élève seul : il joue contre le prof
      const s = present[present.length - 1];
      s.secret = randPerso(); room.profSecret = randPerso(s.secret);
      s.opp = 'prof'; s.status = 'joue';
    }
  }
  broadcast(room);
}

// Si un élève est retiré en plein duel, son adversaire joue contre le prof
function fixPairsAfterLeave(room, goneId) {
  for (const p of room.players.values()) {
    if (p.opp === goneId && p.status === 'joue') {
      if (room.profSecret === null) { p.opp = 'prof'; room.profSecret = randPerso(p.secret); }
      else { p.status = 'attente'; p.opp = null; }
    }
  }
}

function broadcast(room) {
  room.last = Date.now();
  const players = [...room.players.values()];
  const classement = players.map((p) => ({ name: p.name, score: p.score })).sort((a, b) => b.score - a.score);
  const remaining = (p) => NB_PERSOS - p.eliminated.length;
  const oppName = (p) => (p.opp === 'prof' ? 'le prof' : (room.players.get(p.opp) || {}).name || null);

  send(room.profWs, {
    type: 'qec_state', role: 'prof', code: room.code, mode: room.mode, round: room.round,
    active: room.active, revealed: room.revealed, secret: room.secret, profSecret: room.profSecret,
    board: room.board, nextBoard: room.nextBoard,
    players: players.map((p) => {
      const t = room.active ? targetOf(room, p) : null;
      return {
        id: p.id, name: p.name, connected: p.connected, score: p.score, status: p.status, rank: p.rank,
        remaining: remaining(p), secret: p.secret, opp: p.opp, oppName: oppName(p), guess: p.guess,
        target: t, targetGone: t !== null && p.eliminated.includes(t),
      };
    }),
  });

  for (const p of players) {
    if (!p.ws) continue;
    const o = room.players.get(p.opp);
    const done = p.status !== 'joue';
    send(p.ws, {
      type: 'qec_state', role: 'eleve', code: room.code, mode: room.mode, round: room.round,
      active: room.active, revealed: room.revealed, board: room.board,
      me: { name: p.name, score: p.score, status: p.status, why: p.why, rank: p.rank, secret: p.secret, eliminated: p.eliminated, guess: p.guess },
      opp: p.opp ? { name: oppName(p), remaining: o ? remaining(o) : null } : null,
      target: room.active && (done || room.revealed) && p.status !== 'attente' ? targetOf(room, p) : null,
      nbJoueurs: players.length, classement,
    });
  }
}

// Ménage : parties inactives depuis plus de 8 h
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) if (now - r.last > 8 * 3600 * 1000) rooms.delete(code);
}, 30 * 60 * 1000).unref();

module.exports = { attach };
