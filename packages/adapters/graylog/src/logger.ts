import pino from 'pino';

// Create a logger instance for the Graylog adapter
// Users can control log level via LOG_LEVEL env var or PINO_LOG_LEVEL
const logLevel = process.env.LOG_LEVEL || process.env.PINO_LOG_LEVEL || 'info';

export const logger = pino({
  name: 'timebridge:graylog',
  level: logLevel,
  // In development, use pino-pretty for readable output
  ...(process.env.NODE_ENV !== 'production' && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        ignore: 'pid,hostname',
        translateTime: 'HH:MM:ss.l',
        singleLine: false,
      },
    },
  }),
});

// Create child loggers for different components
export const streamLogger = logger.child({ component: 'stream' });
export const csvLogger = logger.child({ component: 'csv' });
export const apiLogger = logger.child({ component: 'api' });
export const queryLogger = logger.child({ component: 'query' });

// Export types for use in other files
export type Logger = pino.Logger;