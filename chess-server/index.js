const express = require('express');
const WebSocket = require('ws');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
require('dotenv').config();

const app = express();
const wss = new WebSocket.Server({ noServer: true });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.connect()
  .then(() => console.log('Connected to PostgreSQL'))
  .catch(err => console.error('Connection error', err.stack));

app.use(cors({
  origin: 'http://localhost:3000',
  methods: ['GET', 'POST'],
}));

app.use(express.json());

const games = {};

function initializeGame(player1, player2) {
  return {
    player1,
    player2,
    board: [
      ['A-P1', 'A-P2', 'A-H1', 'A-H2', 'A-P3'],
      ['', '', '', '', ''],
      ['', '', '', '', ''],
      ['', '', '', '', ''],
      ['B-P1', 'B-P2', 'B-H1', 'B-H2', 'B-P3'],
    ],
    currentPlayer: player1,
    moveHistory: [],
  };
}

function findCharacterPosition(board, character) {
  for (let i = 0; i < board.length; i++) {
    for (let j = 0; j < board[i].length; j++) {
      if (board[i][j] === character) {
        return [i, j];
      }
    }
  }
  return [-1, -1];
}

function validateMove(board, character, direction, x, y) {
  const [newX, newY] = calculateNewPosition(x, y, direction, character);
  
  if (newX < 0 || newX >= board.length || newY < 0 || newY >= board[0].length) {
    return false;
  }

  const targetSquare = board[newX][newY];
  const isOpponent = targetSquare.startsWith(character.startsWith('A') ? 'B' : 'A');

  return targetSquare === '' || isOpponent;
}

function calculateNewPosition(x, y, direction, character) {
  switch (direction) {
    case 'L': y -= 1; break;
    case 'R': y += 1; break;
    case 'U': x -= 1; break;
    case 'D': x += 1; break;
    default: break;
  }
  return [x, y];
}

function processMove(game, player, move) {
  const { board } = game;
  const [character, direction] = move.split(':');
  let [x, y] = findCharacterPosition(board, character);

  if (!validateMove(board, character, direction, x, y)) {
    return false;
  }

  let [newX, newY] = calculateNewPosition(x, y, direction, character);
  if (board[newX][newY].startsWith(player === game.player1 ? 'B' : 'A')) {
    board[newX][newY] = '';
  }

  game.moveHistory.push({ player, move });

  board[x][y] = '';
  board[newX][newY] = `${player === game.player1 ? 'A' : 'B'}-${character.split('-')[1]}`;
  game.currentPlayer = player === game.player1 ? game.player2 : game.player1;

  return true;
}

function isGameOver(game) {
  const pieces = game.board.flat().filter(cell => cell !== '');
  const playerA = pieces.filter(piece => piece.startsWith('A')).length;
  const playerB = pieces.filter(piece => piece.startsWith('B')).length;
  return playerA === 0 || playerB === 0;
}

function generateGameId() {
  return uuidv4();
}

wss.on('connection', (ws) => {
  ws.on('message', async (message) => {
    try {
      const { gameId, player, move } = JSON.parse(message);
      const game = games[gameId];

      if (!game || game.currentPlayer !== player || !processMove(game, player, move)) {
        ws.send(JSON.stringify({ type: 'invalid_move' }));
        return;
      }

      const gameUpdateMessage = JSON.stringify({ type: 'update', gameState: game });

      // Broadcast the updated game state to all connected clients
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(gameUpdateMessage);
        }
      });

      if (isGameOver(game)) {
        const gameOverMessage = JSON.stringify({ type: 'game_over', winner: player });
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(gameOverMessage);
          }
        });
      }

      await updateGameStateInDb(gameId, game);
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
  });

  ws.send(JSON.stringify({ type: 'connection_established' }));
});

app.post('/create-game', async (req, res) => {
  const { player1, player2 } = req.body;
  const gameId = generateGameId();
  const game = initializeGame(player1, player2);
  games[gameId] = game;

  try {
    const result = await pool.query(
      'INSERT INTO games (id, player1_id, player2_id, game_state) VALUES ($1, $2, $3, $4) RETURNING id',
      [gameId, player1, player2, JSON.stringify(game)]
    );
    res.json({ gameId: result.rows[0].id });
  } catch (err) {
    console.error('Database insert error', err.stack);
    res.status(500).json({ error: 'Failed to create game' });
  }
});

app.get('/game/:id', async (req, res) => {
  const gameId = req.params.id;

  try {
    const result = await pool.query(
      'SELECT game_state FROM games WHERE id = $1',
      [gameId]
    );
    if (result.rows.length > 0) {
      res.json(JSON.parse(result.rows[0].game_state));
    } else {
      res.status(404).json({ error: 'Game not found' });
    }
  } catch (err) {
    console.error('Database query error', err.stack);
    res.status(500).json({ error: 'Failed to retrieve game' });
  }
});

app.post('/generate-invite', (req, res) => {
  const { gameId } = req.body;
  const inviteLink = `http://localhost:3000/join-game/${gameId}`;
  res.json({ inviteLink });
});

async function updateGameStateInDb(gameId, gameState) {
  try {
    await pool.query(
      'UPDATE games SET game_state = $1 WHERE id = $2',
      [JSON.stringify(gameState), gameId]
    );
  } catch (err) {
    console.error('Database update error', err.stack);
  }
}

const server = app.listen(8080, () => console.log('Listening on port 8080'));
server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});
