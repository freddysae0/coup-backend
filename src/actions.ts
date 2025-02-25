import {randomUUID} from 'crypto';
import {
  Action,
  Card,
  Discussion,
  Game,
  GameDic,
  Player,
  State,
} from './utils/types';
import {state} from './utils/state';

export const actions: Action[] = [
  'Income',
  'Foreign aid',
  'Coup',
  'Tax',
  'Assassinate',
  'Exchange',
  'Steal',
];

export const addDiscussion = (
  room: string,
  action: Action,
  step: number = 0,
  player: Player,
  game: GameDic,
  playerWhomBeBlessed: Player,
  playerWhomBeCoursed: Player,
  target?: Player,
) => {
  if (!game[room].openDiscussions) game[room].openDiscussions = [];
  game[room].openDiscussions.push({
    room,
    action,
    step: step + 1,
    player,
    target,
    playersVotingToSkip: [],
    playerWhomBeBlessed,
    playerWhomBeCoursed,
  });
};
export const addLoseCardDiscussion = (
  room: string,
  player: Player,
  target: Player,

  playerWhomBeBlessed: Player,
  playerWhomBeCoursed: Player,
) => {
  addDiscussion(
    room,
    'Lose card',
    undefined,
    player,
    state.game,
    playerWhomBeBlessed,
    playerWhomBeCoursed,
    target,
  );
};

export const resolveDiscussion = (room: string, game: GameDic) => {
  game[room].openDiscussions = [];
};

export const playerHaveAction = (player: Player, action: Action) => {
  if (action == 'Income' || action == 'Coup' || action == 'Foreign aid') {
    return true;
  }
  return player.cards.some(
    (card: Card) => card.action.toLowerCase() == action.toLowerCase(),
  );
};
export const playerHaveCounterAction = (
  player: Player,
  counteraction: Action,
) => {
  return player.cards.some((card: Card) => {
    console.log('Counteraction a comparar', counteraction.toLowerCase());
    console.log('Counteraction de la carta', card.counteraction.toLowerCase());
    console.log(
      'Iguales?',
      card.counteraction.toLowerCase() == counteraction.toLowerCase(),
    );
    return card.counteraction.toLowerCase() == counteraction.toLowerCase();
  });
};

export const cardWherePlayerHaveAction = (player: Player, action: Action) => {
  return player.cards.find((card: Card) => card.action == action);
};
const loseACard = (
  room: string,
  player: Player,
  card: number | undefined,
  game: any,
) => {
  let newThrows = new Array<any>();
  game[room].players.forEach((pl: any, i: number) => {
    if (pl.id === player.id) {
      newThrows = game[room].players[i].cards.splice(card, 1);
    }
  });
  game[room].throws.push([...newThrows]);
};

const allPlayersState = () => {
  return {name: 'all'};
};

const processDiscusion = (
  room: string,
  game: GameDic,
  player: Player,
  target: Player | undefined,
  action: Action,
  resolve: boolean,
  step: number,

  playerWhomBeBlessed: Player,
  playerWhomBeCoursed: Player,
) => {
  if (!target) return false;

  if (step == 2) {
    if (playerHaveCounterAction(target, action)) {
      addLoseCardDiscussion(
        room,
        target,
        player,
        playerWhomBeBlessed,
        playerWhomBeCoursed,
      );
    } else {
      addLoseCardDiscussion(
        room,
        player,
        target,
        playerWhomBeBlessed,
        playerWhomBeCoursed,
      );
    }
    /* resolveDiscussion(room, game); */
  }
  if (step == 3) {
    console.log(
      'playerHaveCounterAction',
      playerHaveCounterAction(target, action),
    );
  }
};

const takeIncome = (room: string, player: Player) => {
  state.game[room].players.forEach((pl: Player, i: number) => {
    if (pl.id === player.id) {
      pl.coins += 1;
    }
  });
};

const handleResolve = (
  room: string,
  action: Action,
  step: number,
  player: Player,
  game: GameDic,
  target: Player,
  playerWhomBeBlessed: Player,
  playerWhomBeCoursed: Player,
) => {
  console.log('Handle Resolve');
  if (step % 2 == 0) {
  }

  if (action == 'Foreign aid')
    state.game[room].players.forEach(pl => {
      if (pl.id == playerWhomBeBlessed.id) pl.coins += 2;
    });
  resolveDiscussion(room, game);
};

export default function action(
  room: string,
  action: Action,
  step: number,
  player: Player,
  resolve: boolean,
  game: GameDic,
  playerWhomBeBlessed: Player,
  playerWhomBeCoursed: Player,
  target?: Player,
) {
  console.log('action', action);
  console.log('step', step);
  console.log('player', player);
  console.log('resolve', resolve);
  console.log('target', target);

  let playersVotingToSkip = [];
  if (state.game[room].openDiscussions.length > 0) {
    playersVotingToSkip =
      state.game[room].openDiscussions[
        state.game[room].openDiscussions.length - 1
      ].playersVotingToSkip;
  }

  if (action == 'Income') {
    takeIncome(room, player);
    return true;
  }
  if (target && action == 'Coup') {
    state.game[room].players.forEach(pl => {
      if (pl.id == player.id) pl.coins -= 7;
    });
    addLoseCardDiscussion(
      room,
      player,
      target,
      playerWhomBeBlessed,
      playerWhomBeCoursed,
    );
    return false;
  }
  const lastDiscussion =
    state.game[room].openDiscussions[
      state.game[room].openDiscussions.length - 1
    ];

  if (
    lastDiscussion &&
    lastDiscussion.target &&
    lastDiscussion.action == 'Lose card'
  ) {
    loseACard(room, lastDiscussion.target, lastDiscussion?.cardToThrow, game);
    resolveDiscussion(room, game);
    return true;
  }

  if (step == 2 || step == 3) {
    if (resolve || action == 'Foreign aid')
      return processDiscusion(
        room,
        state.game,
        player,
        target,
        action,
        resolve,
        step,
        playerWhomBeBlessed,
        playerWhomBeCoursed,
      );
    else {
      addDiscussion(
        room,
        action,
        step,
        player,
        game,
        playerWhomBeBlessed,
        playerWhomBeCoursed,
        target,
      );
      return false;
    }
  }
  if (step == 1) {
    if (resolve && target) {
      handleResolve(
        room,
        action,
        step,
        player,
        game,
        target,
        playerWhomBeBlessed,
        playerWhomBeCoursed,
      );
      return true;
    } else {
      addDiscussion(
        room,
        action,
        step,
        player,
        game,
        playerWhomBeBlessed,
        playerWhomBeCoursed,
        target,
      );
    }
  }

  if (step == 0) {
    addDiscussion(
      room,
      action,
      step,
      player,
      game,
      playerWhomBeBlessed,
      playerWhomBeCoursed,
      target,
    );
  }

  /* return winDiscusion(room, action, step, game, player, target);
   */ return false;
}
