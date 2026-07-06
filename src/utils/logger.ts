import 'dotenv/config';
import { format } from 'node:util';

export enum LogLevel {
    INFO = 'INFO',
    DEBUG = 'DEBUG',
    WARN = 'WARN',
    ERROR = 'ERROR',
}

type DiagnosticLevel = 'log' | 'info' | 'debug' | 'warn' | 'error';
type DiagnosticSink = (entry: { level: DiagnosticLevel; message: string }) => void;

export class Logger {
    private isDebug: boolean = false;
    private isSilent: boolean = false;
    private diagnosticSinks: DiagnosticSink[] = [];
    private std = {
        log: console.log,
        info: console.info,
        warn: console.warn,
        error: console.error,
        debug: console.debug,
    };

    hijackConsole() {
        const strip = (args: any[]) => format(...args).replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
        console.log = (...args) => this.log(strip(args));
        console.info = (...args) => this.info(strip(args));
        console.warn = (...args) => this.warn(strip(args));
        console.error = (...args) => {
            const msg = strip(args);
            // Drop redundant Vercel AI SDK stack traces to prevent UI flickering,
            // as we already log structured RateLimit warnings.
            if (msg.includes('Upstream LLM API error') || msg.includes('AI_APICallError')) return;
            this.error(msg);
        };
        console.debug = (...args) => this.debug(strip(args));
    }

    restoreConsole() {
        console.log = this.std.log;
        console.info = this.std.info;
        console.warn = this.std.warn;
        console.error = this.std.error;
        console.debug = this.std.debug;
    }

    setDebug(enabled: boolean) {
        this.isDebug = enabled;
    }

    setSilent(enabled: boolean) {
        this.isSilent = enabled;
    }

    isDebugEnabled(): boolean {
        return this.isDebug;
    }

    async withDiagnosticSink<T>(
        sink: DiagnosticSink,
        fn: () => Promise<T>,
    ): Promise<T> {
        this.diagnosticSinks.push(sink);
        try {
            return await fn();
        } finally {
            const index = this.diagnosticSinks.lastIndexOf(sink);
            if (index >= 0) {
                this.diagnosticSinks.splice(index, 1);
            }
        }
    }

    /** Format a timestamp for consistent log output:  `[HH:MM:SS.mmm]` */
    static formatTimestamp(): string {
        return new Date().toISOString().split('T')[1].replace('Z', '');
    }

    log(message: string, ...args: any[]) {
        if (this.isSilent) return;
        const sink = this.diagnosticSinks[this.diagnosticSinks.length - 1];
        if (sink) {
            sink({ level: 'log', message: format(message, ...args) });
            return;
        }
        this.std.log(message, ...args);
    }

    info(message: string, ...args: any[]) {
        if (this.isSilent) return;
        const sink = this.diagnosticSinks[this.diagnosticSinks.length - 1];
        if (sink) {
            sink({ level: 'info', message: format(message, ...args) });
            return;
        }
        this.std.log(`\x1b[36m›\x1b[0m ${message}`, ...args);
    }

    debug(message: string, ...args: any[]) {
        if (this.isSilent) return;
        if (this.isDebug) {
            const sink = this.diagnosticSinks[this.diagnosticSinks.length - 1];
            if (sink) {
                sink({ level: 'debug', message: format(message, ...args) });
                return;
            }
            const time = Logger.formatTimestamp();
            this.std.log(`› \x1b[90m[${time}] ·\x1b[0m ${message}`, ...args);
        }
    }

    warn(message: string, ...args: any[]) {
        if (this.isSilent) return;
        const sink = this.diagnosticSinks[this.diagnosticSinks.length - 1];
        if (sink) {
            sink({ level: 'warn', message: format(message, ...args) });
            return;
        }
        this.std.warn(`  \x1b[33mwarn\x1b[0m  ${message}`, ...args);
    }

    error(message: string, ...args: any[]) {
        if (this.isSilent) return;
        const sink = this.diagnosticSinks[this.diagnosticSinks.length - 1];
        if (sink) {
            sink({ level: 'error', message: format(message, ...args) });
            return;
        }
        this.std.error(`  \x1b[31merror\x1b[0m ${message}`, ...args);
    }

    // Helper for enterprise-style headers in console
    section(title: string) {
        this.log(`\n\x1b[1m\x1b[36m--- ${title} ---\x1b[0m\n`);
    }

    metrics(report: any) {
        this.log('\n\x1b[1m\x1b[35m[METRICS REPORT]\x1b[0m');
        this.log('═══════════════════════════════════════════');
        this.log(`  Duration:       ${(report.timings.total / 1000).toFixed(2)}s`);
        this.log(`  LLM Time:       ${(report.timings.llm / 1000).toFixed(2)}s`);
        this.log(`  Parsing Time:   ${(report.timings.parsing / 1000).toFixed(2)}s`);
        this.log('───────────────────────────────────────────');
        this.log(`  Files:          ${report.counts.filesProcessed} processed, ${report.counts.filesSkipped} skipped`);
        this.log(`  Functions:      ${report.counts.functionsIngested} ingested, ${report.counts.functionsUnchanged} unchanged, ${report.counts.functionsSkipped} filtered`);
        if (report.counts.errors > 0) {
            this.log(`\x1b[31m  Errors:         ${report.counts.errors}\x1b[0m`);
            if (report.errors && report.errors.length > 0) {
                const maxDisplay = 10;
                const toDisplay = report.errors.slice(0, maxDisplay);
                for (const err of toDisplay) {
                    this.log(`    \x1b[31merror\x1b[0m ${err}`);
                }
                if (report.errors.length > maxDisplay) {
                    this.log(`    \x1b[90m... and ${report.errors.length - maxDisplay} more errors.\x1b[0m`);
                }
            }
        }
        this.log('═══════════════════════════════════════════\n');
    }

    funnel(report: string) {
        this.log(report);
    }
}

export const logger = new Logger();
