export type TeamMember = {
    peerId: string;
    displayName: string;
    address: string;
    joinedAtMs: number;
};
export type TeamRecord = {
    teamId: string;
    teamName: string;
    ownerPeerId: string;
    createdAtMs: number;
    members: TeamMember[];
};
export type InvitePayload = {
    v: 1;
    teamId: string;
    teamName: string;
    ownerPeerId: string;
    ownerAddress: string;
    issuedAtMs: number;
    expiresAtMs: number;
};
export declare class TeamManager {
    private readonly filePath;
    constructor(filePath?: string);
    createTeam(params: {
        teamName: string;
        ownerPeerId: string;
        ownerDisplayName: string;
        ownerAddress: string;
    }): Promise<TeamRecord>;
    listTeams(): Promise<TeamRecord[]>;
    getTeam(teamId: string): Promise<TeamRecord | null>;
    createInvite(params: {
        teamId: string;
        ownerPeerId: string;
        ownerAddress: string;
    }): Promise<string>;
    parseInvite(inviteCode: string): Promise<InvitePayload>;
    verifyInvite(inviteCode: string): Promise<boolean>;
    addMember(params: {
        teamId: string;
        peerId: string;
        displayName: string;
        address: string;
    }): Promise<TeamRecord>;
    joinByInvite(params: {
        invite: InvitePayload;
        localPeerId: string;
        localDisplayName: string;
        localAddress: string;
    }): Promise<TeamRecord>;
    leaveTeam(params: {
        teamId: string;
        peerId: string;
    }): Promise<TeamRecord | null>;
}
