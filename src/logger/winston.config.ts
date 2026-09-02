import { WinstonModuleOptions } from 'nest-winston';
import * as winston from 'winston';
import 'winston-daily-rotate-file';

const isProduction = process.env.NODE_ENV === 'production';

// Human-readable colorized output for the terminal during development
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.colorize({ all: true }),
  winston.format.printf(({ timestamp, level, message, context, stack }) => {
    const ctxStr = context ? JSON.stringify(context) : '';
    const ctx = ctxStr ? `[${ctxStr}] ` : '';
    return `${timestamp} ${level}: ${ctx}${stack || message}`;
  }),
);

// Structured JSON for file transports — searchable later (e.g. all voids by staff X)
const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json(),
);

export const winstonConfig: WinstonModuleOptions = {
  level: isProduction ? 'info' : 'debug',
  transports: [
    new winston.transports.Console({ format: consoleFormat }),
    // All logs (info and above), rotated daily, kept 14 days
    new winston.transports.DailyRotateFile({
      dirname: 'logs',
      filename: 'app-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '14d',
      maxSize: '20m',
      level: 'info',
      format: fileFormat,
    }),
    // Errors only, kept longer (30 days) for incident review
    new winston.transports.DailyRotateFile({
      dirname: 'logs',
      filename: 'error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '30d',
      maxSize: '20m',
      level: 'error',
      format: fileFormat,
    }),
  ],
};
