import { prisma } from "@/lib/prisma";

// 人员在项目语境下的显示名。账号名是注册时自己填的，线上有人填的是拼音（zhimingzeng），
// 团队档案里的 displayName 才是中文名（曾志铭）。取名顺序与项目成员管理页一致：
// 项目内档案名 → 团队档案名 → 账号名。
export function memberDisplayName(accountName: string, projectProfileName?: string | null, teamProfileName?: string | null) {
  return projectProfileName || teamProfileName || accountName;
}

type NamedPerson = { id: string; name: string };

export function projectNameResolver(
  projectMembers: { userId: string; displayName: string | null }[],
  teamProfiles: { userId: string; displayName: string | null }[],
) {
  const projectNames = new Map(projectMembers.map((member) => [member.userId, member.displayName]));
  const teamNames = new Map(teamProfiles.map((member) => [member.userId, member.displayName]));
  return <T extends NamedPerson | null | undefined>(person: T): T => {
    if (!person) return person;
    const name = memberDisplayName(person.name, projectNames.get(person.id), teamNames.get(person.id));
    return name === person.name ? person : ({ ...person, name } as T);
  };
}

export function loadTeamProfiles(
  teamId: string | null | undefined,
  userIds: string[],
): Promise<{ userId: string; displayName: string | null }[]> {
  return teamId
    ? prisma.teamMember.findMany({
        where: { teamId, userId: { in: userIds } },
        select: { userId: true, displayName: true },
      })
    : Promise.resolve([]);
}
