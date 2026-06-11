const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

function broadcast(room, data) {
  const msg = JSON.stringify(data);
  room.players.forEach(ws => {
    if (ws.readyState === 1) ws.send(msg);
  });
}

function sendTo(ws, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
}

const LETTER_DATA = {
  A:{v:1,n:9},B:{v:3,n:2},C:{v:2,n:2},D:{v:2,n:3},E:{v:1,n:15},
  F:{v:4,n:2},G:{v:2,n:2},H:{v:4,n:2},I:{v:1,n:8},J:{v:8,n:1},
  K:{v:10,n:1},L:{v:1,n:5},M:{v:2,n:3},N:{v:1,n:6},O:{v:1,n:6},
  P:{v:3,n:2},Q:{v:8,n:1},R:{v:1,n:6},S:{v:1,n:6},T:{v:1,n:6},
  U:{v:1,n:6},V:{v:4,n:2},W:{v:10,n:1},X:{v:10,n:1},Y:{v:10,n:1},
  Z:{v:10,n:1},'?':{v:0,n:2}
};

const BONUS_MAP = {};
[[0,0],[0,7],[0,14],[7,0],[7,14],[14,0],[14,7],[14,14]].forEach(([r,c])=>BONUS_MAP[r+'_'+c]='TW');
[[1,1],[2,2],[3,3],[4,4],[10,10],[11,11],[12,12],[13,13],[1,13],[2,12],[3,11],[4,10],[10,4],[11,3],[12,2],[13,1],[7,7]].forEach(([r,c])=>BONUS_MAP[r+'_'+c]='DW');
[[1,5],[1,9],[5,1],[5,5],[5,9],[5,13],[9,1],[9,5],[9,9],[9,13],[13,5],[13,9]].forEach(([r,c])=>BONUS_MAP[r+'_'+c]='TL');
[[0,3],[0,11],[2,6],[2,8],[3,0],[3,7],[3,14],[6,2],[6,6],[6,8],[6,12],[7,3],[7,11],[8,2],[8,6],[8,8],[8,12],[11,0],[11,7],[11,14],[12,6],[12,8],[14,3],[14,11]].forEach(([r,c])=>BONUS_MAP[r+'_'+c]='DL');

function makeBag() {
  let bag = [];
  for (let [l, d] of Object.entries(LETTER_DATA)) {
    for (let i = 0; i < d.n; i++) bag.push(l);
  }
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return bag;
}

function drawTiles(rack, bag) {
  while (rack.length < 7 && bag.length > 0) rack.push(bag.pop());
}

function createGame(playerNames) {
  const bag = makeBag();
  const players = playerNames.map(name => {
    const rack = [];
    drawTiles(rack, bag);
    return { name, score: 0, rack };
  });
  return {
    players, bag,
    board: Array.from({length:15}, () => Array(15).fill(null)),
    current: 0, placed: {}, firstMove: true, pass: 0, pendingWord: null, log: []
  };
}

function calcScore(game, cells) {
  let score = 0, wordMult = 1;
  cells.forEach(({r, c, l}) => {
    const key = r+'_'+c;
    const pts = l==='?'?0:(LETTER_DATA[l]?.v||0);
    const b = BONUS_MAP[key];
    const isNew = !!game.placed[key];
    if (isNew && b==='TL') score += pts*3;
    else if (isNew && b==='DL') score += pts*2;
    else score += pts;
    if (isNew && b==='TW') wordMult *= 3;
    else if (isNew && b==='DW') wordMult *= 2;
  });
  score *= wordMult;
  if (Object.keys(game.placed).filter(k=>!k.startsWith('rack_')).length === 7) score += 50;
  return score;
}

function getFullWord(game, cells) {
  const rows = cells.map(c=>c.r), cols = cells.map(c=>c.c);
  const minR=Math.min(...rows), maxR=Math.max(...rows), minC=Math.min(...cols), maxC=Math.max(...cols);
  const isHoriz = minR === maxR;
  let allCells = [];
  if (isHoriz) {
    let startC = minC;
    while (startC > 0 && game.board[minR][startC-1]) startC--;
    let endC = maxC;
    while (endC < 14 && game.board[minR][endC+1]) endC++;
    for (let c = startC; c <= endC; c++) {
      const l = game.board[minR][c]?.l || game.placed[minR+'_'+c];
      if (l) allCells.push({r:minR, c, l});
    }
  } else {
    let startR = minR;
    while (startR > 0 && game.board[startR-1][minC]) startR--;
    let endR = maxR;
    while (endR < 14 && game.board[endR+1][minC]) endR++;
    for (let r = startR; r <= endR; r++) {
      const l = game.board[r][minC]?.l || game.placed[r+'_'+minC];
      if (l) allCells.push({r, c:minC, l});
    }
  }
  return allCells;
}

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.playerIndex = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'create_room') {
      const code = Math.random().toString(36).slice(2,7).toUpperCase();
      rooms[code] = {
        players: [ws], playerNames: [msg.name],
        isProf: [msg.isProf || false], game: null, maxPlayers: msg.maxPlayers || 2
      };
      ws.roomCode = code; ws.playerIndex = 0;
      sendTo(ws, { type: 'room_created', code, playerIndex: 0 });
    }

    else if (msg.type === 'join_room') {
      const room = rooms[msg.code];
      if (!room) { sendTo(ws, { type: 'error', message: 'Salle introuvable.' }); return; }
      if (room.game) { sendTo(ws, { type: 'error', message: 'Partie déjà commencée.' }); return; }
      if (room.players.length >= room.maxPlayers) { sendTo(ws, { type: 'error', message: 'Salle pleine.' }); return; }
      const idx = room.players.length;
      room.players.push(ws); room.playerNames.push(msg.name); room.isProf.push(msg.isProf || false);
      ws.roomCode = msg.code; ws.playerIndex = idx;
      sendTo(ws, { type: 'room_joined', code: msg.code, playerIndex: idx });
      broadcast(room, { type: 'player_joined', players: room.playerNames, count: room.players.length, max: room.maxPlayers });
      if (room.players.length === room.maxPlayers) {
        room.game = createGame(room.playerNames);
        broadcast(room, { type: 'game_start', game: sanitizeGame(room.game), playerNames: room.playerNames });
        room.players.forEach((p, i) => sendTo(p, { type: 'your_rack', rack: room.game.players[i].rack }));
      }
    }

    else if (msg.type === 'place_tiles') {
      const room = rooms[ws.roomCode];
      if (!room || !room.game) return;
      if (room.game.current !== ws.playerIndex) return;
      room.game.placed = msg.placed;
      broadcast(room, { type: 'tiles_placed', placed: msg.placed, playerIndex: ws.playerIndex });
    }

    else if (msg.type === 'submit_word') {
      const room = rooms[ws.roomCode];
      if (!room || !room.game) return;
      const game = room.game;
      if (game.current !== ws.playerIndex) return;

      const cells = Object.keys(game.placed)
        .filter(k=>!k.startsWith('rack_'))
        .map(k=>{const[r,c]=k.split('_').map(Number);return{r,c,l:game.placed[k]};});

      if (cells.length === 0) { sendTo(ws, { type: 'error', message: 'Aucune lettre placée.' }); return; }

      const rows=cells.map(c=>c.r), cols=cells.map(c=>c.c);
      const minR=Math.min(...rows), maxR=Math.max(...rows), minC=Math.min(...cols), maxC=Math.max(...cols);
      if (minR!==maxR && minC!==maxC) { sendTo(ws, { type: 'error', message: 'Les lettres doivent être alignées.' }); return; }

      const isHoriz = minR === maxR;
      if (isHoriz) {
        for (let c=minC; c<=maxC; c++) {
          if (!game.board[minR][c] && !game.placed[minR+'_'+c]) { sendTo(ws, { type: 'error', message: 'Espace vide dans le mot.' }); return; }
        }
      } else {
        for (let r=minR; r<=maxR; r++) {
          if (!game.board[r][minC] && !game.placed[r+'_'+minC]) { sendTo(ws, { type: 'error', message: 'Espace vide dans le mot.' }); return; }
        }
      }

      const allCells = getFullWord(game, cells);
      const word = allCells.map(c=>c.l).join('');

      if (game.firstMove && !game.placed['7_7']) { sendTo(ws, { type: 'error', message: 'Le premier mot doit passer par ★.' }); return; }
      if (!game.firstMove) {
        const adj = cells.some(({r,c})=>[[r-1,c],[r+1,c],[r,c-1],[r,c+1]].some(([nr,nc])=>nr>=0&&nr<15&&nc>=0&&nc<15&&game.board[nr][nc]));
        if (!adj) { sendTo(ws, { type: 'error', message: 'Le mot doit être connecté.' }); return; }
      }

      const score = calcScore(game, allCells);
      game.pendingWord = { word, cells, allCells, score, playerIndex: ws.playerIndex };
      broadcast(room, { type: 'word_pending', word, score, playerName: room.playerNames[ws.playerIndex], playerIndex: ws.playerIndex, placed: game.placed });
    }

    else if (msg.type === 'validate_word') {
      const room = rooms[ws.roomCode];
      if (!room||!room.game||!room.game.pendingWord) return;
      const game=room.game; const pw=game.pendingWord;
      if (msg.accepted) {
        pw.cells.forEach(({r,c,l})=>{game.board[r][c]={l};});
        const usedIdxs=Object.keys(game.placed).filter(k=>k.startsWith('rack_')).map(k=>parseInt(k.split('_')[1]));
        game.players[pw.playerIndex].rack=game.players[pw.playerIndex].rack.filter((_,i)=>!usedIdxs.includes(i));
        drawTiles(game.players[pw.playerIndex].rack, game.bag);
        game.players[pw.playerIndex].score += pw.score;
        game.placed={}; game.firstMove=false; game.pass=0; game.pendingWord=null;
        game.log.push(`✓ "${pw.word}" +${pw.score} pts (${room.playerNames[pw.playerIndex]})`);
        broadcast(room, { type:'word_accepted', word:pw.word, score:pw.score, playerIndex:pw.playerIndex, board:game.board, scores:game.players.map(p=>p.score), bagCount:game.bag.length, log:game.log });
        sendTo(room.players[pw.playerIndex], { type:'your_rack', rack:game.players[pw.playerIndex].rack });
        if (game.players[pw.playerIndex].rack.length===0 && game.bag.length===0) {
          broadcast(room, { type:'game_over', scores:game.players.map(p=>({name:p.name,score:p.score})) }); return;
        }
        game.current=(game.current+1)%game.players.length;
        broadcast(room, { type:'next_turn', current:game.current, currentName:game.players[game.current].name });
      } else {
        game.pendingWord=null;
        broadcast(room, { type:'word_refused', playerIndex:pw.playerIndex, word:pw.word });
        sendTo(room.players[pw.playerIndex], { type:'error', message:`"${pw.word}" refusé. Rappelle tes lettres et réessaie.` });
      }
    }

    else if (msg.type === 'pass_turn') {
      const room=rooms[ws.roomCode];
      if (!room||!room.game) return;
      const game=room.game;
      if (game.current!==ws.playerIndex) return;
      game.placed={}; game.pass++;
      game.log.push(`⏭ ${room.playerNames[ws.playerIndex]} passe`);
      if (game.pass>=game.players.length*2) { broadcast(room, { type:'game_over', scores:game.players.map(p=>({name:p.name,score:p.score})) }); return; }
      game.current=(game.current+1)%game.players.length;
      broadcast(room, { type:'next_turn', current:game.current, currentName:game.players[game.current].name, passed:room.playerNames[ws.playerIndex], log:game.log });
    }

    else if (msg.type === 'ping') { sendTo(ws, { type: 'pong' }); }
  });

  ws.on('close', () => {
    const room = rooms[ws.roomCode];
    if (room) broadcast(room, { type: 'player_left', name: room.playerNames[ws.playerIndex] });
  });
});

function sanitizeGame(game) {
  return { board:game.board, scores:game.players.map(p=>p.score), playerNames:game.players.map(p=>p.name), current:game.current, bagCount:game.bag.length, firstMove:game.firstMove, log:game.log };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Scrabble server running on port ${PORT}`));
