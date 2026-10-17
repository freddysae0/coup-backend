/**
 * Plays a full game with bots against a running server and prints the log.
 *
 *   npm run simulate -- [ws-url] [players] [room]
 *   npm run simulate -- ws://localhost:8000 4
 *
 * Open http://localhost:3000/game/<room> in the browser to watch it live
 * (you will join as a spectator-less extra player only before it starts).
 */
import {Bot} from './bot';

async function main() {
  const url = process.argv[2] || 'ws://localhost:8000';
  const count = Number(process.argv[3] || 4);
  const room = process.argv[4] || `sim-${Date.now().toString(36)}`;
  const names = ['Ana', 'Beto', 'Caro', 'Dani', 'Eva', 'Fede', 'Gabi', 'Hugo'];

  console.log(
    `Simulating a ${count}-player game in room "${room}" on ${url}\n`,
  );
  const bots = Array.from(
    {length: count},
    (_, i) =>
      new Bot({
        url,
        room,
        playerId: `bot-${room}-${i}`,
        name: names[i % names.length],
        thinkMs: 150,
        onLog: i === 0 ? text => console.log(`  ${text}`) : undefined,
      }),
  );
  for (const bot of bots) await bot.connect();
  await bots[0].waitFor(s => s.players.length === count);
  bots[0].send({type: 'start'});
  const final = await bots[0].waitFor(s => s.phase === 'gameOver', 5 * 60_000);
  await new Promise(r => setTimeout(r, 100));
  const winner = final.players.find(p => p.id === final.winnerId);
  console.log(`\nWinner: ${winner?.name ?? 'nobody'}`);
  const errors = bots.flatMap(b => b.errors);
  if (errors.length) console.log(`Rejected moves: ${errors.length}`, errors);
  await Promise.all(bots.map(b => b.disconnect()));
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
