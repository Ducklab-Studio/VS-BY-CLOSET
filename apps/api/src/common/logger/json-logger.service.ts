import { ConsoleLogger, LogLevel } from '@nestjs/common';

/**
 * Logger estruturado para nuvem.
 *
 * Em produção emite uma linha JSON por evento — que é o formato que CloudWatch,
 * Loki, Datadog e afins conseguem indexar. Em desenvolvimento mantém a saída
 * colorida padrão do Nest, que é bem mais legível no terminal.
 */
export class JsonLogger extends ConsoleLogger {
  private readonly asJson = process.env.NODE_ENV === 'production';

  protected printMessages(
    messages: unknown[],
    context = '',
    logLevel: LogLevel = 'log',
    writeStreamType?: 'stdout' | 'stderr',
  ): void {
    if (!this.asJson) {
      return super.printMessages(messages, context, logLevel, writeStreamType);
    }

    for (const message of messages) {
      const entry = {
        level: logLevel,
        time: new Date().toISOString(),
        context: context || undefined,
        ...this.serialize(message),
      };
      const line = `${JSON.stringify(entry)}\n`;
      process[logLevel === 'error' || logLevel === 'fatal' ? 'stderr' : 'stdout'].write(line);
    }
  }

  private serialize(message: unknown): Record<string, unknown> {
    if (message instanceof Error) {
      return { message: message.message, error: message.name, stack: message.stack };
    }
    if (typeof message === 'object' && message !== null) {
      return message as Record<string, unknown>;
    }
    return { message: String(message) };
  }
}
