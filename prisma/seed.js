require("dotenv").config();

const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash("Password123!", 12);

  const admin = await prisma.user.upsert({
    where: { email: "admin@example.com" },
    update: {},
    create: {
      name: "Admin User",
      email: "admin@example.com",
      passwordHash
    }
  });

  const member = await prisma.user.upsert({
    where: { email: "member@example.com" },
    update: {},
    create: {
      name: "Member User",
      email: "member@example.com",
      passwordHash
    }
  });

  const project = await prisma.project.create({
    data: {
      name: "Launch Plan",
      description: "Demo project with team roles and tracked tasks.",
      ownerId: admin.id,
      members: {
        create: [
          { userId: admin.id, role: "ADMIN" },
          { userId: member.id, role: "MEMBER" }
        ]
      },
      tasks: {
        create: [
          {
            title: "Create product brief",
            description: "Draft the one-page launch brief.",
            status: "IN_PROGRESS",
            assigneeId: member.id,
            creatorId: admin.id,
            dueDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000)
          },
          {
            title: "Review dashboard metrics",
            status: "TODO",
            assigneeId: admin.id,
            creatorId: admin.id,
            dueDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000)
          }
        ]
      }
    }
  });

  console.log(`Seeded demo project: ${project.name}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
