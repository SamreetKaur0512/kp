export function fanChatHistoryFilter(user) {
  const createdAt = user?.createdAt;
  if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) return {};
  return { createdAt: { $gte: createdAt } };
}
