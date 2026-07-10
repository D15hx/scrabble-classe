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
  room.players.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
}
function sendTo(ws, data) { if (ws.readyState === 1) ws.send(JSON.stringify(data)); }

// ─── SCRABBLE ───────────────────────────────────────────────────────────────

const LETTER_DATA = {
  A:{v:1,n:9},B:{v:3,n:2},C:{v:2,n:2},D:{v:2,n:3},E:{v:1,n:15},F:{v:4,n:2},G:{v:2,n:2},
  H:{v:4,n:2},I:{v:1,n:8},J:{v:8,n:1},K:{v:10,n:1},L:{v:1,n:5},M:{v:2,n:3},N:{v:1,n:6},
  O:{v:1,n:6},P:{v:3,n:2},Q:{v:8,n:1},R:{v:1,n:6},S:{v:1,n:6},T:{v:1,n:6},U:{v:1,n:6},
  V:{v:4,n:2},W:{v:10,n:1},X:{v:10,n:1},Y:{v:10,n:1},Z:{v:10,n:1},'?':{v:0,n:2}
};
const BONUS_MAP = {};
[[0,0],[0,7],[0,14],[7,0],[7,14],[14,0],[14,7],[14,14]].forEach(([r,c])=>BONUS_MAP[r+'_'+c]='TW');
[[1,1],[2,2],[3,3],[4,4],[10,10],[11,11],[12,12],[13,13],[1,13],[2,12],[3,11],[4,10],[10,4],[11,3],[12,2],[13,1]].forEach(([r,c])=>BONUS_MAP[r+'_'+c]='DW');
[[1,5],[1,9],[5,1],[5,5],[5,9],[5,13],[9,1],[9,5],[9,9],[9,13],[13,5],[13,9]].forEach(([r,c])=>BONUS_MAP[r+'_'+c]='TL');
[[0,3],[0,11],[2,6],[2,8],[3,0],[3,7],[3,14],[6,2],[6,6],[6,8],[6,12],[7,3],[7,11],[8,2],[8,6],[8,8],[8,12],[11,0],[11,7],[11,14],[12,6],[12,8],[14,3],[14,11]].forEach(([r,c])=>BONUS_MAP[r+'_'+c]='DL');

function makeBag() {
  let bag = [];
  for (let [l, d] of Object.entries(LETTER_DATA)) for (let i = 0; i < d.n; i++) bag.push(l);
  for (let i = bag.length-1; i > 0; i--) { const j=Math.floor(Math.random()*(i+1)); [bag[i],bag[j]]=[bag[j],bag[i]]; }
  return bag;
}
function drawTiles(rack, bag) { while (rack.length < 7 && bag.length > 0) rack.push(bag.pop()); }
function createScrabbleGame(playerNames) {
  const bag = makeBag();
  const players = playerNames.map(name => { const rack=[]; drawTiles(rack,bag); return {name,score:0,rack}; });
  return { type:'scrabble', players, bag, board:Array.from({length:15},()=>Array(15).fill(null)), current:0, placed:{}, firstMove:true, pass:0, pendingWord:null, log:[] };
}
function scoreWord(placed, cells) {
  let score=0, wordMult=1;
  cells.forEach(({r,c,l})=>{
    const key=r+'_'+c, pts=l==='?'?0:(LETTER_DATA[l]?.v||0), b=BONUS_MAP[key], isNew=!!placed[key];
    if(isNew&&b==='TL') score+=pts*3; else if(isNew&&b==='DL') score+=pts*2; else score+=pts;
    if(isNew&&b==='TW') wordMult*=3; else if(isNew&&b==='DW') wordMult*=2;
  });
  return score*wordMult;
}
function extendWord(board, placed, r, c, horiz) {
  let cells=[];
  if(horiz){
    let sc=c; while(sc>0&&(board[r][sc-1]||placed[r+'_'+(sc-1)])) sc--;
    let ec=c; while(ec<14&&(board[r][ec+1]||placed[r+'_'+(ec+1)])) ec++;
    for(let cc=sc;cc<=ec;cc++){const l=board[r][cc]?.l||placed[r+'_'+cc];if(l)cells.push({r,c:cc,l});}
  } else {
    let sr=r; while(sr>0&&(board[sr-1][c]||placed[(sr-1)+'_'+c])) sr--;
    let er=r; while(er<14&&(board[er+1][c]||placed[(er+1)+'_'+c])) er++;
    for(let rr=sr;rr<=er;rr++){const l=board[rr][c]?.l||placed[rr+'_'+c];if(l)cells.push({r:rr,c,l});}
  }
  return cells;
}
function calcTotalScore(board, placed, newCells, isHoriz) {
  let total=0; const words=[];
  const mainWord=extendWord(board,placed,newCells[0].r,newCells[0].c,isHoriz);
  if(mainWord.length>=1){const s=scoreWord(placed,mainWord);total+=s;words.push({word:mainWord.map(c=>c.l).join(''),score:s});}
  newCells.forEach(({r,c})=>{
    const cross=extendWord(board,placed,r,c,!isHoriz);
    if(cross.length>1){const s=scoreWord(placed,cross);total+=s;words.push({word:cross.map(x=>x.l).join(''),score:s});}
  });
  if(newCells.length===7) total+=50;
  return {total,words};
}

// ─── IMPOSTEUR ──────────────────────────────────────────────────────────────

const WORD_PAIRS = [
  ['plage','piscine'],['chien','chat'],['pizza','burger'],['voiture','moto'],
  ['mer','lac'],['avion','train'],['pomme','poire'],['soleil','lune'],
  ['football','basketball'],['café','thé'],['livre','magazine'],['école','université'],
  ['printemps','automne'],['montagne','colline'],['guitare','violon'],['médecin','infirmier'],
  ['boulangerie','pâtisserie'],['cinéma','théâtre'],['forêt','jungle'],['château','manoir'],
  ['roi','président'],['piano','orgue'],['requin','dauphin'],['tigre','lion'],
  ['Paris','Londres'],['neige','grêle'],['désert','savane'],['spaghetti','macaroni'],['chocolat','caramel']
];

function createImposteurGame(playerNames, mode, variant, wordA, wordB) {
  let realWord, imposteurWord;
  if (mode === 'auto') {
    const pair = WORD_PAIRS[Math.floor(Math.random()*WORD_PAIRS.length)];
    [realWord, imposteurWord] = Math.random()<0.5 ? pair : [pair[1],pair[0]];
  } else { realWord=wordA; imposteurWord=wordB; }
  const imposteurIdx = Math.floor(Math.random()*playerNames.length);
  const players = playerNames.map((name,i) => ({
    name, word: i===imposteurIdx?(variant==='mystery'?'???':imposteurWord):realWord,
    isImposteur:i===imposteurIdx, hints:[], vote:null
  }));
  return { type:'imposteur', mode, variant, realWord, imposteurWord, imposteurIdx, players, phase:'hints', current:0, round:1, maxRounds:3, log:[] };
}

// ─── PETIT BAC ──────────────────────────────────────────────────────────────

function randomLetter() {
  return 'ABCDEFGHIJLMNOPRSTV'[Math.floor(Math.random()*19)];
}

function createPetitBacGame(playerNames, playerColors, categories, targetScore, timerSeconds, profIsPlayer) {
  const scores = {};
  playerNames.forEach(n => scores[n] = 0);
  return { type:'petit-bac', playerNames, playerColors, categories, targetScore, timerSeconds, profIsPlayer, scores, phase:'waiting', letter:null, round:0, answers:{}, finisher:null, timerHandle:null };
}

// ─── WEBSOCKET ──────────────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  ws.roomCode = null; ws.playerIndex = null; ws.playerName = null; ws.playerColor = '#2563eb';

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'create_room') {
      const code = Math.random().toString(36).slice(2,7).toUpperCase();
      ws.playerColor = msg.color || '#2563eb';
      ws.playerName = msg.name;
      rooms[code] = {
        players:[ws], playerNames:[msg.name], playerColors:[ws.playerColor], isProf:[true],
        game:null, maxPlayers:msg.maxPlayers||2, gameType:msg.gameType||'scrabble',
        categories:msg.categories||[], targetScore:msg.targetScore||20,
        timerSeconds:msg.timerSeconds||0, isProfPlayer:msg.isProfPlayer||false
      };
      ws.roomCode=code; ws.playerIndex=0;
      sendTo(ws,{type:'room_created',code,playerIndex:0});
    }

    else if (msg.type === 'join_room') {
      const room=rooms[msg.code];
      if(!room){sendTo(ws,{type:'error',message:'Salle introuvable.'});return;}
      if(room.game&&room.gameType==='scrabble'){sendTo(ws,{type:'error',message:'Partie déjà commencée.'});return;}
      if(room.players.length>=room.maxPlayers){sendTo(ws,{type:'error',message:'Salle pleine.'});return;}
      const color=msg.color||'#2563eb';
      if(room.playerColors&&room.playerColors.includes(color)&&room.gameType==='petit-bac'){sendTo(ws,{type:'error',message:'Cette couleur est déjà prise !'});return;}
      const idx=room.players.length;
      ws.playerColor=color; ws.playerName=msg.name;
      room.players.push(ws); room.playerNames.push(msg.name);
      if(!room.playerColors) room.playerColors=[];
      room.playerColors.push(color);
      room.isProf.push(false);
      ws.roomCode=msg.code; ws.playerIndex=idx;
      sendTo(ws,{type:'room_joined',code:msg.code,playerIndex:idx,takenColors:room.playerColors});
      broadcast(room,{type:'player_joined',players:room.playerNames,colors:room.playerColors,count:room.players.length,max:room.maxPlayers,code:msg.code});
      if(room.gameType==='petit-bac'){
        sendTo(ws,{type:'pb_config',categories:room.categories,targetScore:room.targetScore,timerSeconds:room.timerSeconds,playerNames:room.playerNames,colors:room.playerColors});
      }
      if(room.players.length===room.maxPlayers&&room.gameType==='scrabble'){
        room.game=createScrabbleGame(room.playerNames);
        broadcast(room,{type:'game_start',game:sanitizeScrabble(room.game),playerNames:room.playerNames});
        room.players.forEach((p,i)=>sendTo(p,{type:'your_rack',rack:room.game.players[i].rack}));
      }
    }

    // ── PETIT BAC ──
    else if (msg.type === 'pb_start_round') {
      const room=rooms[ws.roomCode]; if(!room) return;
      if(!room.game) room.game=createPetitBacGame(room.playerNames,room.playerColors,room.categories,room.targetScore,room.timerSeconds,room.isProfPlayer);
      const game=room.game;
      if(game.timerHandle){clearTimeout(game.timerHandle);game.timerHandle=null;}
      game.letter=randomLetter(); game.answers={}; game.finisher=null; game.phase='letter';
      broadcast(room,{type:'pb_letter',letter:game.letter});
    }

    else if (msg.type === 'pb_reroll') {
      const room=rooms[ws.roomCode]; if(!room||!room.game) return;
      room.game.letter=randomLetter();
      broadcast(room,{type:'pb_letter',letter:room.game.letter});
    }

    else if (msg.type === 'pb_go') {
      const room=rooms[ws.roomCode]; if(!room||!room.game) return;
      const game=room.game;
      game.phase='playing';
      broadcast(room,{type:'pb_start_playing',letter:game.letter,timerSeconds:room.timerSeconds});
      if(room.timerSeconds>0){
        game.timerHandle=setTimeout(()=>{
          if(game.phase==='playing'){
            game.finisher='⏱ Temps écoulé';
            game.phase='finished';
            broadcast(room,{type:'pb_finished',finisher:'⏱ Temps écoulé'});
            setTimeout(()=>{
              broadcast(room,{type:'pb_validate',answers:game.answers,playerNames:room.playerNames,colors:room.playerColors,categories:room.categories});
            },2000);
          }
        }, room.timerSeconds*1000);
      }
    }

    else if (msg.type === 'pb_answer') {
      const room=rooms[ws.roomCode]; if(!room||!room.game) return;
      const game=room.game; if(game.phase!=='playing') return;
      if(!game.answers[ws.playerName]) game.answers[ws.playerName]={};
      game.answers[ws.playerName][msg.category]=msg.answer;
      broadcast(room,{type:'pb_answer_update',playerName:ws.playerName,category:msg.category,masked:msg.masked});
    }

    else if (msg.type === 'pb_finish') {
      const room=rooms[ws.roomCode]; if(!room||!room.game) return;
      const game=room.game; if(game.phase!=='playing'||game.finisher) return;
      if(game.timerHandle){clearTimeout(game.timerHandle);game.timerHandle=null;}
      game.finisher=ws.playerName; game.phase='finished';
      if(msg.answers) game.answers[ws.playerName]=msg.answers;
      broadcast(room,{type:'pb_finished',finisher:ws.playerName});
      setTimeout(()=>{
        broadcast(room,{type:'pb_validate',answers:game.answers,playerNames:room.playerNames,colors:room.playerColors,categories:room.categories});
      },2000);
    }

    else if (msg.type === 'pb_submit_points') {
      const room=rooms[ws.roomCode]; if(!room||!room.game) return;
      const game=room.game;
      const roundPoints={};
      room.playerNames.forEach(n=>roundPoints[n]=0);
      Object.entries(msg.points).forEach(([playerName,catPoints])=>{
        Object.entries(catPoints).forEach(([cat,pts])=>{
          const ans=game.answers[playerName]&&game.answers[playerName][cat];
          if(ans&&ans.trim()!==''){
            roundPoints[playerName]=(roundPoints[playerName]||0)+Number(pts);
          }
        });
        game.scores[playerName]=(game.scores[playerName]||0)+roundPoints[playerName];
      });
      const scores=room.playerNames.map(n=>({name:n,score:game.scores[n]||0}));
      const winner=scores.find(s=>s.score>=game.targetScore);
      broadcast(room,{type:'pb_scores',scores,roundPoints,finished:!!winner,winner:winner?.name});
      if(!winner){game.phase='waiting';setTimeout(()=>broadcast(room,{type:'pb_next_round'}),3000);}
    }

    // ── IMPOSTEUR ──
    else if (msg.type === 'start_imposteur') {
      const room=rooms[ws.roomCode]; if(!room) return;
      if(room.players.length<3){sendTo(ws,{type:'error',message:'Il faut au moins 3 joueurs.'});return;}
      room.game=createImposteurGame(room.playerNames,msg.mode,msg.variant,msg.wordA,msg.wordB);
      broadcast(room,{type:'imposteur_start',playerNames:room.playerNames,playerCount:room.players.length});
      room.players.forEach((p,i)=>sendTo(p,{type:'your_word',word:room.game.players[i].word}));
      broadcast(room,{type:'imposteur_phase',phase:'hints',current:0,currentName:room.playerNames[0],round:1,maxRounds:3});
    }

    else if (msg.type === 'submit_hint') {
      const room=rooms[ws.roomCode]; if(!room||!room.game) return;
      const game=room.game; if(game.type!=='imposteur'||game.phase!=='hints') return;
      if(game.current!==ws.playerIndex) return;
      const hint=(msg.hint||'').trim().slice(0,50);
      if(!hint){sendTo(ws,{type:'error',message:'Indice vide.'});return;}
      game.players[ws.playerIndex].hints.push(hint);
      broadcast(room,{type:'hint_added',playerIndex:ws.playerIndex,playerName:room.playerNames[ws.playerIndex],hint,hints:game.players.map(p=>p.hints),log:game.log});
      const allGaveHint=game.players.every(p=>p.hints.length>=game.round);
      if(allGaveHint){
        if(game.round>=game.maxRounds){game.phase='vote';broadcast(room,{type:'imposteur_phase',phase:'vote',playerNames:room.playerNames});}
        else{game.round++;game.current=0;broadcast(room,{type:'imposteur_phase',phase:'hints',current:0,currentName:room.playerNames[0],round:game.round,maxRounds:game.maxRounds});}
      } else {
        game.current=(game.current+1)%game.players.length;
        broadcast(room,{type:'imposteur_phase',phase:'hints',current:game.current,currentName:room.playerNames[game.current],round:game.round,maxRounds:game.maxRounds});
      }
    }

    else if (msg.type === 'submit_vote') {
      const room=rooms[ws.roomCode]; if(!room||!room.game) return;
      const game=room.game; if(game.type!=='imposteur'||game.phase!=='vote') return;
      game.players[ws.playerIndex].vote=msg.votedIndex;
      broadcast(room,{type:'vote_update',votes:game.players.map(p=>p.vote),playerNames:room.playerNames});
      const allVoted=game.players.every(p=>p.vote!==null);
      if(allVoted){
        const tally=Array(game.players.length).fill(0);
        game.players.forEach(p=>{if(p.vote!==null)tally[p.vote]++;});
        const suspected=tally.indexOf(Math.max(...tally));
        game.phase='reveal';
        broadcast(room,{type:'imposteur_reveal',imposteurIdx:game.imposteurIdx,imposteurName:room.playerNames[game.imposteurIdx],realWord:game.realWord,imposteurWord:game.variant==='mystery'?'???':game.imposteurWord,variant:game.variant,suspected,suspectedName:room.playerNames[suspected],tally,playerNames:room.playerNames,votes:game.players.map(p=>p.vote)});
      }
    }

    // ── SCRABBLE ──
    else if (msg.type === 'place_tiles') {
      const room=rooms[ws.roomCode]; if(!room||!room.game) return;
      if(room.game.current!==ws.playerIndex) return;
      room.game.placed=msg.placed;
      broadcast(room,{type:'tiles_placed',placed:msg.placed,playerIndex:ws.playerIndex});
    }

    else if (msg.type === 'submit_word') {
      const room=rooms[ws.roomCode]; if(!room||!room.game) return;
      const game=room.game; if(game.current!==ws.playerIndex) return;
      const newCells=Object.keys(game.placed).filter(k=>!k.startsWith('rack_')).map(k=>{const[r,c]=k.split('_').map(Number);return{r,c,l:game.placed[k]};});
      if(newCells.length===0){sendTo(ws,{type:'error',message:'Aucune lettre placée.'});return;}
      const rows=newCells.map(c=>c.r),cols=newCells.map(c=>c.c);
      const minR=Math.min(...rows),maxR=Math.max(...rows),minC=Math.min(...cols),maxC=Math.max(...cols);
      if(minR!==maxR&&minC!==maxC){sendTo(ws,{type:'error',message:'Les lettres doivent être alignées.'});return;}
      const isHoriz=minR===maxR;
      if(isHoriz){for(let c=minC;c<=maxC;c++)if(!game.board[minR][c]&&!game.placed[minR+'_'+c]){sendTo(ws,{type:'error',message:'Espace vide.'});return;}}
      else{for(let r=minR;r<=maxR;r++)if(!game.board[r][minC]&&!game.placed[r+'_'+minC]){sendTo(ws,{type:'error',message:'Espace vide.'});return;}}
      if(game.firstMove&&!game.placed['7_7']){sendTo(ws,{type:'error',message:'Le premier mot doit passer par ★.'});return;}
      if(!game.firstMove){
        const adj=newCells.some(({r,c})=>[[r-1,c],[r+1,c],[r,c-1],[r,c+1]].some(([nr,nc])=>nr>=0&&nr<15&&nc>=0&&nc<15&&game.board[nr][nc]));
        if(!adj){sendTo(ws,{type:'error',message:'Le mot doit être connecté.'});return;}
      }
      const {total,words}=calcTotalScore(game.board,game.placed,newCells,isHoriz);
      const mainWord=words.length>0?words[0].word:'';
      const allWords=words.map(w=>w.word).join(', ');
      game.pendingWord={word:mainWord,allWords,words,cells:newCells,total,playerIndex:ws.playerIndex};
      broadcast(room,{type:'word_pending',word:mainWord,allWords,words,score:total,playerName:room.playerNames[ws.playerIndex],playerIndex:ws.playerIndex,placed:game.placed});
    }

    else if (msg.type === 'validate_word') {
      const room=rooms[ws.roomCode]; if(!room||!room.game||!room.game.pendingWord) return;
      const game=room.game; const pw=game.pendingWord;
      if(msg.accepted){
        pw.cells.forEach(({r,c,l})=>{game.board[r][c]={l};});
        const usedIdxs=Object.keys(game.placed).filter(k=>k.startsWith('rack_')).map(k=>parseInt(k.split('_')[1]));
        game.players[pw.playerIndex].rack=game.players[pw.playerIndex].rack.filter((_,i)=>!usedIdxs.includes(i));
        drawTiles(game.players[pw.playerIndex].rack,game.bag);
        game.players[pw.playerIndex].score+=pw.total;
        game.placed={};game.firstMove=false;game.pass=0;game.pendingWord=null;
        const logEntry=pw.words.length>1?`✓ ${pw.words.map(w=>`"${w.word}"+${w.score}`).join('|')}=+${pw.total}pts`:` ✓ "${pw.word}" +${pw.total} pts (${room.playerNames[pw.playerIndex]})`;
        game.log.push(logEntry);
        broadcast(room,{type:'word_accepted',word:pw.allWords,score:pw.total,playerIndex:pw.playerIndex,board:game.board,scores:game.players.map(p=>p.score),bagCount:game.bag.length,log:game.log});
        sendTo(room.players[pw.playerIndex],{type:'your_rack',rack:game.players[pw.playerIndex].rack});
        if(game.players[pw.playerIndex].rack.length===0&&game.bag.length===0){broadcast(room,{type:'game_over',scores:game.players.map(p=>({name:p.name,score:p.score}))});return;}
        game.current=(game.current+1)%game.players.length;
        broadcast(room,{type:'next_turn',current:game.current,currentName:game.players[game.current].name,log:game.log});
      } else {
        game.pendingWord=null;
        broadcast(room,{type:'word_refused',playerIndex:pw.playerIndex,word:pw.word});
        sendTo(room.players[pw.playerIndex],{type:'error',message:`"${pw.word}" refusé. Rappelle tes lettres et réessaie.`});
      }
    }

    else if (msg.type === 'pass_turn') {
      const room=rooms[ws.roomCode]; if(!room||!room.game) return;
      const game=room.game; if(game.current!==ws.playerIndex) return;
      game.placed={};game.pass++;
      game.log.push(`⏭ ${room.playerNames[ws.playerIndex]} passe`);
      if(game.pass>=game.players.length*2){broadcast(room,{type:'game_over',scores:game.players.map(p=>({name:p.name,score:p.score}))});return;}
      game.current=(game.current+1)%game.players.length;
      broadcast(room,{type:'next_turn',current:game.current,currentName:game.players[game.current].name,log:game.log});
    }

    else if (msg.type === 'exchange_tile') {
      const room=rooms[ws.roomCode]; if(!room||!room.game) return;
      const game=room.game; if(game.current!==ws.playerIndex) return;
      if(game.bag.length===0){sendTo(ws,{type:'error',message:'Plus de lettres.'});return;}
      const player=game.players[ws.playerIndex];
      const idx=msg.tileIndex;
      if(idx===undefined||idx<0||idx>=player.rack.length) return;
      const old=player.rack[idx];
      game.bag.unshift(old);
      for(let i=game.bag.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[game.bag[i],game.bag[j]]=[game.bag[j],game.bag[i]];}
      player.rack[idx]=game.bag.pop();
      game.placed={};game.pass=0;
      sendTo(ws,{type:'your_rack',rack:player.rack,exchangedIdx:idx});
      game.current=(game.current+1)%game.players.length;
      broadcast(room,{type:'next_turn',current:game.current,currentName:game.players[game.current].name,log:game.log});
    }

    else if (msg.type === 'ping') { sendTo(ws,{type:'pong'}); }
  });

  ws.on('close', ()=>{
    const room=rooms[ws.roomCode];
    if(room) broadcast(room,{type:'player_left',name:room.playerNames[ws.playerIndex]});
  });
});

function sanitizeScrabble(game) {
  return {board:game.board,scores:game.players.map(p=>p.score),playerNames:game.players.map(p=>p.name),current:game.current,bagCount:game.bag.length,firstMove:game.firstMove,log:game.log};
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=>console.log(`Serveur jeux de classe — port ${PORT}`));