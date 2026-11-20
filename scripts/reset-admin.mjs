import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../apps/server/dist/security.js';

const password = process.env.TATTOO_NEW_PASSWORD;
if (!password || password.length < 12 || password.length > 256)
  throw new Error('请通过 TATTOO_NEW_PASSWORD 环境变量提供 12 至 256 个字符的新密码');
if (!process.env.DATABASE_URL || !/^postgres(ql)?:\/\//.test(process.env.DATABASE_URL))
  throw new Error('请配置 PostgreSQL DATABASE_URL');
const database = new PrismaClient();
try {
  const passwordHash = hashPassword(password);
  await database.$transaction(async (transaction) => {
    await transaction.$queryRaw`SELECT pg_advisory_xact_lock(8472902)::text AS locked`;
    const users = await transaction.user.findMany({ select: { id: true }, take: 2 });
    if (users.length !== 1) throw new Error('实例必须已有且只有一个管理员');
    await transaction.user.update({ where: { id: users[0].id }, data: { passwordHash } });
    await transaction.session.deleteMany({ where: { userId: users[0].id } });
  });
  console.info('管理员密码已重置，全部旧会话已撤销。');
} catch {
  console.error('密码重置失败，请检查数据库连接、迁移和管理员状态。');
  process.exitCode = 1;
} finally {
  delete process.env.TATTOO_NEW_PASSWORD;
  await database.$disconnect();
}
