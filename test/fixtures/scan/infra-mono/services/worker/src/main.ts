// Stand-in for bullmq + the S3 client (the fixture has no node_modules).
export const exportJob = (id: string, data: unknown): string => `exports/${id}.json:${JSON.stringify(data)}`;
