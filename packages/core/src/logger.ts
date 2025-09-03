import pino from 'pino';

const logger = pino({
  name: 'timebridge:core',
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      ignore: 'pid,hostname',
      translateTime: 'SYS:HH:MM:ss.l',
    }
  }
});

export const routerLogger = logger.child({ component: 'router' });
export const duckdbLogger = logger.child({ component: 'duckdb' });
export const joinerLogger = logger.child({ component: 'joiner' });
export const optimizerLogger = logger.child({ component: 'optimizer' });

export default logger;