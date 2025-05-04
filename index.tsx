import { getItem, storage } from '../localStorage';
import { Platform } from 'react-native';
import { APP_ENV } from './getEnv';
import crashlytics from '@react-native-firebase/crashlytics';

interface LogEntry {
    type: 'log' | 'error' | 'warn';
    message: string;
    params: string;
    timestamp: number;
    hash?: string;
}

class Logger {
    private static _instance: Logger;
    private logQueue: LogEntry[] = [];
    private timerHandle: NodeJS.Timeout | null = null;
    private errorHashes: Set<string> = new Set();
    private readonly QUEUE_KEY = 'logger_queue';
    private readonly FLUSH_INTERVAL = 60 * 60 * 1000;

    private constructor() {
        this.init();
    }

    private async init(): Promise<void> {
        try {
            try {
                await crashlytics().setCrashlyticsCollectionEnabled(true);
                console.log('[Logger] Crashlytics initialized successfully as remote logging service');

                const userId = await getItem('userID');
                const platform = Platform.OS;

                await crashlytics().setUserId(userId ? userId : 'anonymous_user');
                await crashlytics().setAttribute('environment', String(APP_ENV));
                await crashlytics().setAttribute('platform', String(platform));
                //TODO: set actual app version
                await crashlytics().setAttribute('app_version', '1.0.0');

                // Restore any saved queue from storage
                await this.restoreQueue();
                this.startFlushTimer();
            } catch (crashlyticsError) {
                console.error('[Logger] Failed to initialize Crashlytics:', crashlyticsError);
            }
        } catch (err) {
            console.error("Failed to initialize logger service:", err);
            throw err;
        }
    }

    public static get instance(): Logger {
        if (!Logger._instance) {
            Logger._instance = new Logger();
        }
        return Logger._instance;
    }

    private startFlushTimer(): void {
        if (this.timerHandle) {
            clearInterval(this.timerHandle);
        }

        this.timerHandle = setInterval(() => {
            this.flushLogs();
        }, this.FLUSH_INTERVAL);
    }

    private async restoreQueue(): Promise<void> {
        try {
            const savedQueue = storage.getString(this.QUEUE_KEY);
            if (savedQueue) {
                const parsedQueue = JSON.parse(savedQueue) as LogEntry[];
                this.logQueue = parsedQueue;

                parsedQueue.forEach(entry => {
                    if (entry.type === 'error' && entry.hash) {
                        this.errorHashes.add(entry.hash);
                    }
                });

                console.log(`[Logger] Restored ${this.logQueue.length} queued logs`);
            }
        } catch (error) {
            console.error('[Logger] Failed to restore queue:', error);
        }
    }

    private saveQueue(): void {
        try {
            storage.set(this.QUEUE_KEY, JSON.stringify(this.logQueue));
        } catch (error) {
            console.error('[Logger] Failed to save queue:', error);
        }
    }

    private async flushLogs(): Promise<void> {
        if (this.logQueue.length === 0) return;

        console.log(`[Logger] Flushing ${this.logQueue.length} logs to Crashlytics`);

        try {
            const errorLogs = this.logQueue.filter(entry => entry.type === 'error');
            const normalLogs = this.logQueue.filter(entry => entry.type !== 'error');

            for (const entry of normalLogs) {
                await crashlytics().log(`[${entry.type.toUpperCase()}] ${entry.message} ${entry.params}`);
            }

            for (const entry of errorLogs) {
                await crashlytics().log(`[ERROR] ${entry.message} ${entry.params}`);
                await crashlytics().recordError(new Error(`${entry.message} ${entry.params}`));
            }

            this.logQueue = [];
            this.errorHashes.clear();
            this.saveQueue();

            console.log('[Logger] Successfully flushed logs to Crashlytics');
        } catch (error) {
            console.error('[Logger] Failed to flush logs:', error);
        }
    }

    private generateErrorHash(message: string, params: string): string {
        return `${message}:${params}`;
    }

    private queueLog(type: 'log' | 'error' | 'warn', message: string, params: string): void {
        const entry: LogEntry = {
            type,
            message,
            params,
            timestamp: Date.now()
        };

        if (type === 'error') {
            const hash = this.generateErrorHash(message, params);

            if (this.errorHashes.has(hash)) {
                console.log('[Logger] Skipping duplicate error:', message);
                return;
            }

            entry.hash = hash;
            this.errorHashes.add(hash);
        }

        this.logQueue.push(entry);
        this.saveQueue();
    }

    log(message: string, ...optionalParams: any[]): void {
        const logMessage = `[LOG] ${message}`;
        console.log(logMessage, ...optionalParams);

        try {
            const formattedParams = this.formatParams(optionalParams);
            this.queueLog('log', logMessage, formattedParams);
        } catch (error) {
            console.error('[Logger] Failed to queue log:', error);
        }
    }

    debug(message: string, ...optionalParams: any[]): void {
        if (__DEV__) {
            const debugMessage = `[DEBUG] ${message}`;
            console.debug(debugMessage, ...optionalParams);
        }
    }

    error(message: string, ...optionalParams: any[]): void {
        const errorMessage = `[ERROR] ${message}`;
        console.error(errorMessage, ...optionalParams);

        try {
            const formattedParams = this.formatParams(optionalParams);
            this.queueLog('error', errorMessage, formattedParams);
        } catch (error) {
            console.error('[Logger] Failed to queue error:', error);
        }
    }

    warn(message: string, ...optionalParams: any[]): void {
        const warnMessage = `[WARN] ${message}`;
        console.warn(warnMessage, ...optionalParams);

        try {
            const formattedParams = this.formatParams(optionalParams);
            this.queueLog('warn', warnMessage, formattedParams);
        } catch (error) {
            console.error('[Logger] Failed to queue warning:', error);
        }
    }

    private formatParams(params: any[]): string {
        if (params.length === 0) return '';

        try {
            const formattedParams = params.map(param => {
                if (typeof param === 'object' && param !== null) {
                    return JSON.stringify(param);
                }
                return String(param);
            }).join(' ');

            return formattedParams;
        } catch (error) {
            console.error('[Logger] Error formatting log parameters:', error);
            return '[Error formatting parameters]';
        }
    }

    public forceFlush(): void {
        this.flushLogs();
    }
}

export const logger = Logger.instance;