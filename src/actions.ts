import {randomUUID} from 'crypto';

type Action =
  | 'Income'
  | 'Foreign aid'
  | 'Coup'
  | 'Tax'
  | 'Assassinate'
  | 'Exchange'
  | 'Steal';
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
  action: string,
  player: any,
  target: any,
  game: any,
  parent: string | undefined,
) => {
  if (!game[room].openDiscussions) game[room].openDiscussions = [];
  const uuid = randomUUID();
  game[room].openDiscussions.push({id: uuid, action, player, target, parent});
};

export const resolveParents = (recursionStart: any) => {
  if (!recursionStart.parent) return;

  resolveParents(recursionStart.parent);
};
export const resolveDiscussion = (
  room: string,
  game: any,
  discussionId: string,
) => {
  game[room].openDiscussions = [];
  /* 
    if (!game[room].openDiscussions) game[room].openDiscussions = [];
  if (game[room].openDiscussions.length == 0) return;
  const discussionIndex = game[room].openDiscussions.findIndex((disc: any) => {
    return disc.id == discussionId;
  });
  const discussionParent = game[room].openDiscussions[discussionIndex].parent;
  game[room].openDiscussions.splice(discussionIndex, 1);

  if (discussionParent) resolveDiscussion(room, game, discussionParent); */
};

export const playerHaveAction = (player: any, action: Action) => {
  if (action == 'Income' || action == 'Coup' || action == 'Foreign aid') {
    return true;
  }
  return player.cards.some(
    (card: any) => card.action.toLowerCase() == action.toLowerCase(),
  );
};
export const playerHaveCounterAction = (player: any, counteraction: Action) => {
  return player.cards.some((card: any) => {
    console.log('card.counteraction', card.counteraction);
    console.log('counteraction', counteraction);
    return card.counteraction.toLowerCase() == counteraction.toLowerCase();
  });
};

export const cardWherePlayerHaveAction = (player: any, action: Action) => {
  return player.cards.find((card: any) => card.action == action);
};
const loseACard = (room: string, player: any, card: string, game: any) => {
  let newThrows = new Array<any>();
  game[room].players.forEach((pl: any, i: number) => {
    if (pl.id === player.id) {
      game[room].players[i].cards.forEach((c: any, j: number) => {
        if (c.name === card)
          newThrows = game[room].players[i].cards.splice(j, 1);
      });
    }
  });
  game[room].throws.push([...newThrows]);
};

const allPlayersState = () => {
  return {name: 'all'};
};
export default function action(
  room: string,
  player: any,
  action: any,
  target: any = undefined,
  game: any,
  discussionId: string | undefined,
) {
  switch (action) {
    case 'Income':
      game[room].players.forEach((pl: any) => {
        if (pl.id === player.id) pl.coins += 1;
      });
      return true;
      break;
    case 'Coup':
      addDiscussion(room, 'Coup', player, target, game, undefined);
      return false;
      break;
    case 'ResolveCoup':
      //addDiscussion(room, 'Coup', player, target, game);
      loseACard(room, player, target, game);
      resolveDiscussion(room, game, discussionId || '');
      return true;
      break;
    case 'Foreign aid':
      addDiscussion(
        room,
        'Foreign aid',
        player,
        allPlayersState(),
        game,
        undefined,
      );
      return false;
    case 'DenyForeign aid':
      addDiscussion(
        room,
        'DenyForeign aid',
        player,
        target,
        game,
        discussionId,
      );
      //resolveDiscussion(room, 'Foreign aid', player, undefined, game);
      return false;
      break;
    case 'ChallengeDenyForeign aid':
      console.log('HASTA AQUI PINCHA');
      if (!playerHaveCounterAction(target, 'Foreign aid')) {
        //const card = cardWherePlayerHaveAction(target, 'Foreign aid');
        //swapCardWithDeck(game[room].deck, card, target);
        addDiscussion(
          room,
          'Wins challenge',
          player,
          target,
          game,
          discussionId,
        );
      } else {
        addDiscussion(
          room,
          'Wins challenge',
          target,
          player,
          game,
          discussionId,
        );
      }
      //resolveDiscussion(room, 'Foreign aid', player, undefined, game);
      return false;
      break;

    case 'Lose a card':
      loseACard(room, player, target, game);
      if (discussionId) resolveDiscussion(room, game, discussionId);

      return true;

    default:
      break;
  }
}
