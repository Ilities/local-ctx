import pino, { Logger } from 'pino';

export const createRootLogger: () => Logger = () =>
  pino({
    level: process.env['LOG_LEVEL'] || 'debug',
    timestamp: pino.stdTimeFunctions.isoTime,
  });
