// Minimal MCP (stdio JSON-RPC) client for the pen.dev desktop app's bundled MCP server.
// Used by the verification tooling to open converted files and export renders.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';

const SERVER =
  process.env.PEN_MCP_SERVER ?? `/Applications/Pen.app/Contents/Resources/app.asar.unpacked/out/mcp-server-darwin-${process.arch === 'x64' ? 'x64' : 'arm64'}`;

export class PenMcp {
  private proc: ChildProcessWithoutNullStreams;
  private buf = '';
  private seq = 0;
  private pending = new Map<number, (msg: { result?: unknown; error?: { message: string } }) => void>();
  private ready: Promise<void>;

  constructor() {
    if (!existsSync(SERVER)) throw new Error(`pen.dev MCP server not found at ${SERVER} – set PEN_MCP_SERVER`);
    this.proc = spawn(SERVER, ['--app', 'desktop', '--agent', 'sketch2pen'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (d: string) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id != null && this.pending.has(msg.id)) {
          this.pending.get(msg.id)!(msg);
          this.pending.delete(msg.id);
        }
      }
    });
    // The server must finish its handshake with the app before tool calls are accepted.
    this.ready = new Promise((resolve) => {
      const timer = setTimeout(resolve, 6000);
      this.proc.stderr.on('data', (d: Buffer) => {
        if (d.toString().includes('send agent name')) {
          clearTimeout(timer);
          setTimeout(resolve, 400);
        }
      });
    });
  }

  private rpc(method: string, params: unknown): Promise<{ result?: unknown; error?: { message: string } }> {
    const id = ++this.seq;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async init(): Promise<void> {
    await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'sketch2pen', version: '0.1' } });
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    await this.ready;
  }

  async call(name: string, args: Record<string, unknown>, timeoutMs = 300_000): Promise<string> {
    const res = await Promise.race([
      this.rpc('tools/call', { name, arguments: args }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${name} timed out`)), timeoutMs)),
    ]);
    if (res.error) throw new Error(res.error.message);
    const content = (res.result as { content?: { type: string; text?: string }[]; isError?: boolean }) ?? {};
    const text = (content.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (content.isError) throw new Error(text);
    return text;
  }

  async activeFile(): Promise<string | null> {
    const state = await this.call('get_app_state', {});
    return state.match(/active canvas editor: `([^`]+)`/)?.[1] ?? null;
  }

  close(): void {
    this.proc.kill();
  }
}
