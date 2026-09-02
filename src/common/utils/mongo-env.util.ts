export function isOnlineMongoMode(): boolean {
  return (process.env.MONGODB_ONLINE ?? 'off').trim().toLowerCase() === 'on';
}
