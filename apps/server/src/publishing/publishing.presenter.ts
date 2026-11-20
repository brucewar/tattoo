export const publicDelivery = {
  account: { select: { id: true, name: true, platform: true } },
  revision: { select: { id: true, title: true, version: true, articleId: true } },
  events: {
    orderBy: { createdAt: 'asc' as const },
    select: { actor: true, message: true, createdAt: true },
  },
};
