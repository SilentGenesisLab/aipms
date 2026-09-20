import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getRequestUserId } from "@/lib/team-permissions";
import { getProjectAccess } from "@/lib/project-permissions";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const userId = await getRequestUserId(request);
  const { projectId } = await params;
  if (!userId) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const access = await getProjectAccess(projectId, userId);
  if (!access?.canAccess)
    return NextResponse.json({ error: "无权访问该项目" }, { status: 403 });
  const [requirements, tasks, bugs, rawVersions, releases, members, rawFiles] =
    await Promise.all([
      prisma.requirement.findMany({
        where: { projectId },
        include: {
          targetVersion: { select: { id: true, name: true } },
          requester: { select: { id: true, name: true } },
          owner: { select: { id: true, name: true } },
          participants: { include: { user: { select: { id: true, name: true } } } },
          _count: { select: { tasks: true, bugs: true } },
        },
        orderBy: { updatedAt: "desc" },
      }),
      prisma.task.findMany({
        where: { projectId },
        include: {
          requirement: { select: { id: true, code: true, title: true } },
          version: { select: { id: true, name: true } },
          assignee: { select: { id: true, name: true } },
          coordinator: { select: { id: true, name: true } },
          acceptor: { select: { id: true, name: true } },
          dependencies: { select: { dependsOnId: true } },
          reports: { select: { createdAt: true }, orderBy: { createdAt: "desc" }, take: 1 },
          _count: { select: { reports: true, bugs: true } },
        },
        orderBy: { updatedAt: "desc" },
      }),
      prisma.bug.findMany({
        where: { projectId },
        include: {
          requirement: { select: { id: true, code: true, title: true } },
          task: { select: { id: true, code: true, title: true } },
          foundVersion: { select: { id: true, name: true } },
          fixedVersion: { select: { id: true, name: true } },
        },
        orderBy: { updatedAt: "desc" },
      }),
      prisma.version.findMany({
        where: { projectId },
        include: {
          owner: { select: { id: true, name: true } },
          participants: { include: { user: { select: { id: true, name: true } } } },
          _count: {
            select: {
              requirements: true,
              tasks: true,
              fixedBugs: true,
              releases: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.release.findMany({
        where: { projectId },
        include: { version: { select: { id: true, name: true } } },
        orderBy: { createdAt: "desc" },
      }),
      prisma.projectMember.findMany({
        where: { projectId },
        include: { user: { select: { id: true, name: true, phone: true } } },
        orderBy: { user: { name: "asc" } },
      }),
      prisma.fileAsset.findMany({
        where: { projectId, deletedAt: null },
        select: { id: true, name: true, mimeType: true, size: true, updatedAt: true },
        orderBy: { updatedAt: "desc" },
      }),
    ]);
  const versionLinks = rawVersions.length
    ? await prisma.resourceLink.findMany({
        where: { resourceType: "VERSION", resourceId: { in: rawVersions.map((x) => x.id) } },
        select: { resourceId: true, fileId: true },
      })
    : [];
  const versions = rawVersions.map((version) => ({
    ...version,
    fileIds: versionLinks.filter((x) => x.resourceId === version.id).map((x) => x.fileId),
  }));
  return NextResponse.json({
    currentUserId: userId,
    requirements,
    tasks: tasks.map(({ reports, ...task }) => ({ ...task, submittedAt: reports[0]?.createdAt || null })),
    bugs,
    versions,
    releases,
    members: members.map((x) => ({ ...x.user, role: x.role })),
    files: rawFiles.map((file) => ({ ...file, size: file.size.toString() })),
    permissions: {
      canWrite: Boolean(
        access.canManage ||
        (access.projectMember && access.projectMember.role !== "GUEST"),
      ),
      canDelete: access.canManage,
    },
  });
}
