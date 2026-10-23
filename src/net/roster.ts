import type { Team } from '../sim/car';
import { MAX_TEAM_PLAYERS, type LobbyPlayer } from './protocol';

/** Shared by the host authority and lobby UI; the moving player doesn't consume a second place. */
export function teamCount(players: readonly LobbyPlayer[], team: Team, exceptSlot = -1): number {
  return players.filter((p) => p.team === team && p.slot !== exceptSlot).length;
}

export function teamHasSpace(players: readonly LobbyPlayer[], team: Team, exceptSlot = -1): boolean {
  return teamCount(players, team, exceptSlot) < MAX_TEAM_PLAYERS;
}

/** New arrivals fill the smaller side. With eight places, neither side can exceed four. */
export function balancedTeam(players: readonly LobbyPlayer[]): Team {
  return teamCount(players, 'blue') <= teamCount(players, 'orange') ? 'blue' : 'orange';
}
