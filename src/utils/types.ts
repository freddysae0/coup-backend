export type Room = string;

export type Action =
  | 'Income' // Take 1 coin from the Treasury
  | 'Foreign aid' // Take 2 coins from the Treasury (Can be blocked by Duke)
  | 'Coup' // Pay 7 coins and launch a Coup
  | 'Tax' // Duke Action: Take 3 coins from the Treasury
  | 'Assassinate' // Assassin Action: Pay 3 coins to assassinate another player
  | 'Steal' // Captain Action: Take 2 coins from another player (or 1 if they have only 1)
  | 'Exchange' // Ambassador Action: Exchange cards with the Court
  | 'None' // None Action (only Contessa have it)
  | 'Lose card'; // None Action (only Contessa have it)

export type CounterAction =
  | 'Foreign Aid' // Duke blocks Foreign Aid
  | 'Assassinate' // Contessa blocks Assassinate
  | 'Steal'; // Ambassador or Captain blocks Steal

export type Card = {
  id: number;
  name: 'Duke' | 'Assassin' | 'Captain' | 'Ambassador' | 'Contessa'; // Fixed names for characters
  action: Action; // Action associated with the card
  counteraction: CounterAction; // Counteraction capability, null if none
};
export type Player = {
  id: string;
  name: string;
  cards: Card[];
  coins: number;
  isHost: boolean;
  isBeingChallenged: boolean; // Track if the action is being challenged
};

export type Game = {
  deck: Card[];
  throws: Card[];
  players: Player[];
  isGameStarted: boolean;
  openDiscussions: Discussion[];
  turn: Player; // Player whose turn it is
};
export type GameDic = {
  [key: string]: Game;
};

export type State = {
  game: {
    [key: string]: Game;
  };
  clients: {
    [key: string]: WebSocket[];
  };
  turns: {
    [key: string]: Player;
  };
};

export type ChallengeOutcome =
  | 'Wins challenge'
  | 'Loses challenge'
  | 'Lose a card'
  | 'ResolveCoup'
  | 'DenyForeign aid'
  | 'ChallengeDenyForeign aid';

export type Discussion = {
  room: Room;
  action: Action;
  step: number;
  player: Player;
  playersVotingToSkip: Player[];
  cardToThrow?: number;
  target?: Player;

  playerWhomBeBlessed: Player;
  playerWhomBeCoursed: Player;
};

export type Req = {
  type:
    | 'get'
    | 'isGameStarted'
    | 'createRoom'
    | 'updatePlayerName'
    | 'playTurn'
    | 'startGame';
  room?: string;
  content?: any;
  game?: GameDic;
  player: Player;
  action: Action;
  target?: Player;
  step: number;
  resolve?: boolean;
  playerWhomBeBlessed: Player;
  playerWhomBeCoursed: Player;
};
