export type TeamMember = {
    url: string;
    name: string;
    description?: string;
    joinedAtMs: number;
};
export type TeamRecord = {
    teamId: string;
    teamName: string;
    selfUrl: string;
    members: TeamMember[];
    createdAtMs: number;
};
export type InvitePayload = {
    /** teamId */
    t: string;
    /** seed URL */
    u: string;
};
export declare function encodeInvite(teamId: string, seedUrl: string): string;
export declare function decodeInvite(code: string): InvitePayload;
export declare class TeamStore {
    private readonly filePath;
    constructor(filePath: string);
    private readStore;
    createTeam(params: {
        teamName: string;
        selfUrl: string;
        selfName: string;
        selfDescription?: string;
    }): Promise<TeamRecord>;
    getTeam(teamId: string): Promise<TeamRecord | null>;
    listTeams(): Promise<TeamRecord[]>;
    getFirstTeam(): Promise<TeamRecord | null>;
    addMember(teamId: string, member: TeamMember): Promise<boolean>;
    removeMember(teamId: string, memberUrl: string): Promise<boolean>;
    deleteTeam(teamId: string): Promise<boolean>;
    saveTeam(team: TeamRecord): Promise<void>;
}
