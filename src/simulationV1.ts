import type { TeamBoostV1Id, TEAM_BOOST_V1_VERSION } from "./teamBoostV1.js";

export const SIMULATION_V1_VERSION = "simulation-v1" as const;

export const FRANCHISES_2016 = [
  { id: "delhi-daredevils", name: "Delhi Daredevils" },
  { id: "gujarat-lions", name: "Gujarat Lions" },
  { id: "kings-xi-punjab", name: "Kings XI Punjab" },
  { id: "kolkata-knight-riders", name: "Kolkata Knight Riders" },
  { id: "mumbai-indians", name: "Mumbai Indians" },
  { id: "rising-pune-supergiants", name: "Rising Pune Supergiants" },
  { id: "royal-challengers-bangalore", name: "Royal Challengers Bangalore" },
  { id: "sunrisers-hyderabad", name: "Sunrisers Hyderabad" },
] as const;

export type Franchise2016Id = (typeof FRANCHISES_2016)[number]["id"];
export type SimulationTeamId = "user" | Franchise2016Id;

export type TeamStrengthSnapshot = {
  battingComposite: number;
  bowlingComposite: number;
  overallTeamRating: number;
};

export type OpponentStrengthProfile = {
  franchiseId: Franchise2016Id;
  franchiseName: string;
  season: 2016;
  baseStrength: TeamStrengthSnapshot;
  adjustedStrength: TeamStrengthSnapshot;
  boostVersion: typeof TEAM_BOOST_V1_VERSION;
  appliedBoostIds: readonly TeamBoostV1Id[];
};

export type LeagueTeam =
  | {
      teamId: "user";
      displayName: string;
      replacedFranchiseId: Franchise2016Id;
    }
  | {
      teamId: Franchise2016Id;
      displayName: string;
      opponentProfile: OpponentStrengthProfile;
    };

export type ScheduledLeagueMatch = {
  id: string;
  round: number;
  leg: 1 | 2;
  homeTeamId: SimulationTeamId;
  awayTeamId: SimulationTeamId;
};

export const SIMULATION_V1_LEAGUE_CONSTANTS = {
  teams: 8,
  roundsPerLeg: 7,
  legs: 2,
  matchesPerRound: 4,
  matchesPerTeam: 14,
  totalMatches: 56,
} as const;

export function isFranchise2016Id(value: string): value is Franchise2016Id {
  return FRANCHISES_2016.some((franchise) => franchise.id === value);
}

export function createLeagueComposition(
  replacedFranchiseId: Franchise2016Id,
  profiles: readonly OpponentStrengthProfile[],
): LeagueTeam[] {
  if (!isFranchise2016Id(replacedFranchiseId)) {
    throw new Error(`Unknown 2016 franchise: ${replacedFranchiseId}`);
  }
  const profilesById = new Map(profiles.map((profile) => [profile.franchiseId, profile]));
  if (profilesById.size !== FRANCHISES_2016.length) {
    throw new Error("League composition requires one opponent profile for every 2016 franchise.");
  }

  return FRANCHISES_2016.map((franchise): LeagueTeam => {
    if (franchise.id === replacedFranchiseId) {
      return {
        teamId: "user",
        displayName: franchise.name,
        replacedFranchiseId,
      };
    }
    const opponentProfile = profilesById.get(franchise.id);
    if (!opponentProfile) {
      throw new Error(`Missing opponent profile for ${franchise.name}.`);
    }
    return {
      teamId: franchise.id,
      displayName: franchise.name,
      opponentProfile,
    };
  });
}

export function generateDoubleRoundRobinSchedule(teams: readonly LeagueTeam[]): ScheduledLeagueMatch[] {
  validateScheduleTeams(teams);
  let rotation = teams.map((team) => team.teamId);
  const firstLeg: ScheduledLeagueMatch[] = [];

  for (let roundIndex = 0; roundIndex < SIMULATION_V1_LEAGUE_CONSTANTS.roundsPerLeg; roundIndex += 1) {
    for (let matchIndex = 0; matchIndex < SIMULATION_V1_LEAGUE_CONSTANTS.matchesPerRound; matchIndex += 1) {
      const left = rotation[matchIndex];
      const right = rotation[rotation.length - 1 - matchIndex];
      const swap = (roundIndex + matchIndex) % 2 === 1;
      firstLeg.push({
        id: matchId(roundIndex + 1, matchIndex + 1),
        round: roundIndex + 1,
        leg: 1,
        homeTeamId: swap ? right : left,
        awayTeamId: swap ? left : right,
      });
    }
    rotation = [rotation[0], rotation[rotation.length - 1], ...rotation.slice(1, -1)];
  }

  const secondLeg = firstLeg.map((match, index): ScheduledLeagueMatch => {
    const round = match.round + SIMULATION_V1_LEAGUE_CONSTANTS.roundsPerLeg;
    const matchIndex = index % SIMULATION_V1_LEAGUE_CONSTANTS.matchesPerRound;
    return {
      id: matchId(round, matchIndex + 1),
      round,
      leg: 2,
      homeTeamId: match.awayTeamId,
      awayTeamId: match.homeTeamId,
    };
  });
  return [...firstLeg, ...secondLeg];
}

function validateScheduleTeams(teams: readonly LeagueTeam[]): void {
  if (teams.length !== SIMULATION_V1_LEAGUE_CONSTANTS.teams) {
    throw new Error("A Simulation V1 league requires exactly eight teams.");
  }
  const ids = teams.map((team) => team.teamId);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Simulation V1 league team IDs must be unique.");
  }
  if (!ids.includes("user")) {
    throw new Error("A Simulation V1 league must contain the user team.");
  }
}

function matchId(round: number, match: number): string {
  return `league-r${String(round).padStart(2, "0")}-m${String(match).padStart(2, "0")}`;
}
